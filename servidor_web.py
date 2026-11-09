#!/usr/bin/env python3
"""Versión web del agente de ventas: API con FastAPI + interfaz HTML/JS."""

import argparse
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import json
import uuid

from copilot.session_events import SessionEventType
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

from agente_ventas import DEFAULT_MODEL, ROOT, create_client, create_session, get_api_key

WEB_DIR = ROOT / "web"
RESPONSE_TIMEOUT = 300.0  # segundos máximos por respuesta del agente
MAX_CONVERSATIONS = 50


@dataclass
class Conversation:
    session: object
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    queue: asyncio.Queue | None = None


class ChatRequest(BaseModel):
    conversation_id: str | None = Field(None, description="Vacío para empezar una conversación nueva")
    message: str = Field(min_length=1, max_length=4000)


state: dict = {"client": None, "model": DEFAULT_MODEL, "conversations": {}}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    get_api_key()  # falla al arrancar si no hay clave, con un mensaje claro
    client = create_client()
    await client.start()
    state["client"] = client
    try:
        yield
    finally:
        for conversation in state["conversations"].values():
            try:
                await conversation.session.disconnect()
            except Exception:
                pass
        await client.stop()


app = FastAPI(title="Agente de ventas", lifespan=lifespan)


def to_message(event) -> dict | None:
    """Traduce un evento del SDK al mensaje que recibe el navegador."""
    data = event.data
    if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
        return {"type": "delta", "text": data.delta_content or ""}
    if event.type == SessionEventType.TOOL_EXECUTION_START:
        args = data.arguments if isinstance(data.arguments, dict) else {}
        return {"type": "tool_start", "id": data.tool_call_id, "sql": args.get("sql", "")}
    if event.type == SessionEventType.TOOL_EXECUTION_COMPLETE:
        message = {"type": "tool_end", "id": data.tool_call_id, "success": data.success}
        if data.result is not None:
            message["result"] = data.result.content
        if data.error is not None:
            message["error"] = data.error.message
        return message
    if event.type == SessionEventType.SESSION_ERROR:
        return {"type": "error", "message": data.message}
    return None


async def get_conversation(conversation_id: str | None) -> tuple[str, Conversation]:
    conversations = state["conversations"]
    if conversation_id:
        if conversation_id not in conversations:
            raise HTTPException(404, "La conversación no existe (¿se reinició el servidor?)")
        return conversation_id, conversations[conversation_id]

    if len(conversations) >= MAX_CONVERSATIONS:  # descarta la más antigua
        oldest_id = next(iter(conversations))
        oldest = conversations.pop(oldest_id)
        try:
            await oldest.session.disconnect()
        except Exception:
            pass

    session = await create_session(state["client"], state["model"])
    conversation = Conversation(session=session)

    def on_event(event):
        message = to_message(event)
        if message is not None and conversation.queue is not None:
            conversation.queue.put_nowait(message)

    session.on(on_event)
    conversation_id = uuid.uuid4().hex
    conversations[conversation_id] = conversation
    return conversation_id, conversation


def sse(message: dict) -> str:
    return f"data: {json.dumps(message, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(request: ChatRequest):
    conversation_id, conversation = await get_conversation(request.conversation_id)
    if conversation.lock.locked():
        raise HTTPException(409, "El agente todavía está respondiendo en esta conversación")

    async def stream():
        async with conversation.lock:
            queue = conversation.queue = asyncio.Queue()
            yield sse({"type": "start", "conversation_id": conversation_id})
            task = asyncio.create_task(
                conversation.session.send_and_wait(request.message, timeout=RESPONSE_TIMEOUT)
            )
            error_sent = False
            try:
                while True:
                    getter = asyncio.create_task(queue.get())
                    done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                    pending = [getter.result()] if getter in done else []
                    if getter not in done:
                        getter.cancel()
                        while not queue.empty():
                            pending.append(queue.get_nowait())
                    for message in pending:
                        error_sent = error_sent or message["type"] == "error"
                        yield sse(message)
                    if getter not in done:
                        break
                error = task.exception()
                if error_sent:
                    pass  # el SDK ya informó del error con un evento de sesión
                elif error is not None:
                    yield sse({"type": "error", "message": str(error) or type(error).__name__})
                elif task.result() is None:
                    yield sse({"type": "error", "message": "El agente terminó sin responder"})
                yield sse({"type": "done"})
            finally:
                conversation.queue = None
                if not task.done():  # el navegador cerró la conexión
                    task.cancel()
                    try:
                        await conversation.session.abort()
                    except Exception:
                        pass

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/chat/{conversation_id}")
async def end_conversation(conversation_id: str):
    conversation = state["conversations"].pop(conversation_id, None)
    if conversation is not None:
        try:
            await conversation.session.disconnect()
        except Exception:
            pass
    return {"ok": True}


@app.get("/api/info")
async def info():
    return {"model": state["model"]}


@app.get("/")
async def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Interfaz web del agente de ventas")
    parser.add_argument("--host", default="127.0.0.1", help="Usa 0.0.0.0 dentro del contenedor")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--modelo", default=DEFAULT_MODEL, help="Modelo de OpenRouter")
    args = parser.parse_args()
    state["model"] = args.modelo
    uvicorn.run(app, host=args.host, port=args.port)
