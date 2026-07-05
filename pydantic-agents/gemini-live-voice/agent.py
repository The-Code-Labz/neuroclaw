# LiveKit agent worker: joins neuroclaw-neuro-room and relays audio to Gemini Live.
# The NeuroClaw agent specified by LIVEKIT_AGENT_ID provides the system prompt
# and tool configuration; Gemini handles voice conversation in real-time.
#
# Run: python agent.py dev
# Production: python agent.py start

import os
import asyncio
import logging
import httpx
from dotenv import load_dotenv

load_dotenv()

from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli, llm
from livekit.agents.voice_assistant import VoiceAssistant
from livekit.plugins import google as livekit_google
from tools import to_gemini_declarations

logger = logging.getLogger('gemini-live-voice')
logging.basicConfig(level=logging.INFO)

DASHBOARD_URL   = os.environ['DASHBOARD_URL']
DASHBOARD_TOKEN = os.environ['DASHBOARD_TOKEN']
AGENT_ID        = os.environ['LIVEKIT_AGENT_ID']
ROOM_NAME       = os.environ.get('LIVEKIT_ROOM_NAME', 'neuroclaw-neuro-room')
GEMINI_API_KEY  = os.environ['GEMINI_API_KEY']
GEMINI_MODEL    = os.environ.get('GEMINI_LIVE_MODEL', 'gemini-2.0-flash-live')
GEMINI_VOICE    = os.environ.get('GEMINI_LIVE_VOICE', 'Zephyr')
TOOL_TIMEOUT    = 10.0  # seconds


async def fetch_agent_config() -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f'{DASHBOARD_URL}/api/agents/{AGENT_ID}',
            headers={'x-dashboard-token': DASHBOARD_TOKEN},
            timeout=10.0,
        )
        r.raise_for_status()
        return r.json()


async def execute_tool(tool_name: str, args: dict, agent_id: str) -> str:
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f'{DASHBOARD_URL}/api/tools/execute',
                headers={
                    'x-dashboard-token': DASHBOARD_TOKEN,
                    'Content-Type': 'application/json',
                },
                json={'tool': tool_name, 'args': args, 'agent_id': agent_id},
                timeout=TOOL_TIMEOUT,
            )
            data = r.json()
            return data.get('result', 'No result')
    except Exception as e:
        return f'Error: {e}'


async def entrypoint(ctx: JobContext):
    logger.info('gemini-live-voice: connecting to room %s', ROOM_NAME)
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Fetch agent config from NeuroClaw
    agent_cfg = await fetch_agent_config()
    system_prompt    = agent_cfg.get('system_prompt') or ''
    gemini_voice     = agent_cfg.get('gemini_live_voice') or GEMINI_VOICE
    tools_enabled    = bool(agent_cfg.get('gemini_tools_enabled', 1))
    openai_tools     = agent_cfg.get('tools') or []

    # Convert tools to Gemini FunctionDeclarations
    function_declarations = to_gemini_declarations(openai_tools) if tools_enabled else []

    # Build Gemini Live model
    # ⚠️ Verify livekit-plugins-google API against current docs before running
    model = livekit_google.LLM.with_gemini(
        model=GEMINI_MODEL,
        api_key=GEMINI_API_KEY,
        voice=gemini_voice,
    )

    # Wire up tool calling
    async def on_function_call(fn_call):
        result = await execute_tool(fn_call.name, fn_call.arguments, AGENT_ID)
        return result

    assistant = VoiceAssistant(
        vad=ctx.proc.userdata.get('vad'),
        stt=None,
        llm=model,
        tts=None,
        chat_ctx=llm.ChatContext().append(
            role='system', text=system_prompt
        ),
        fnc_ctx=llm.FunctionContext(
            functions={d.name: on_function_call for d in function_declarations}
        ) if function_declarations else None,
    )

    assistant.start(ctx.room)
    logger.info('gemini-live-voice: assistant started in room %s for agent %s', ROOM_NAME, AGENT_ID)
    await asyncio.sleep(float('inf'))


if __name__ == '__main__':
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
