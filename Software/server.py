import asyncio
import ssl
import aiohttp
from aiohttp import web

ESP32_IP = "192.168.1.178"       #Hardcoded cause its a personal project and I wanted to simplify it(let the server know which is the ESP and other devices).
ESP32_CAM_URL = f"http://{ESP32_IP}:8080/stream"
HTTPS_PORT = 8000

# Paths relative to project root (or data/ folder)
CERT_FILE = "data/cert.pem"
KEY_FILE = "data/key.pem"

connected_clients = set()


def get_client_label(request):
    """Identifies whether the incoming client is the ESP32 or a Web Browser."""
    peername = request.transport.get_extra_info('peername')
    ip = peername[0] if peername else request.remote
    user_agent = request.headers.get("User-Agent", "Unknown")

    # ESP32 identifies via custom User-Agent or IP match
    if ip == ESP32_IP or "ESP32" in user_agent:
        return f"[ESP32 Hardware ({ip})]"
    return f"[Browser Client ({ip})]"


async def handle_index(request):
    client = get_client_label(request)
    print(f"[HTTPS] {client} requested /")
    return web.FileResponse("static/index.html")


async def handle_video_feed(request):
    client = get_client_label(request)
    print(f"[HTTPS] {client} opened /video_feed proxy stream")

    response = web.StreamResponse(
        status=200,
        reason="OK",
        headers={"Content-Type": "multipart/x-mixed-replace; boundary=frame"}
    )
    await response.prepare(request)

    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(ESP32_CAM_URL, timeout=None) as resp:
                async for chunk in resp.content.iter_chunked(1024):
                    await response.write(chunk)
        except Exception as e:
            print(f"[CAM PROXY ERROR] {e}")

    return response


async def handle_audio_ws(request):
    client_label = get_client_label(request)
    
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    connected_clients.add(ws)
    print(f"[WSS CONNECTED] {client_label} active on /ws/audio")

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                for client in list(connected_clients):
                    if client != ws and not client.closed:
                        await client.send_bytes(msg.data)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                print(f"[WSS ERROR] {client_label}: {ws.exception()}")
    finally:
        connected_clients.remove(ws)
        print(f"[WSS DISCONNECTED] {client_label} left /ws/audio")

    return ws


async def main():
    app = web.Application()

    # Route definitions
    app.router.add_get("/", handle_index)
    app.router.add_get("/video_feed", handle_video_feed)
    app.router.add_get("/ws/audio", handle_audio_ws)
    app.router.add_static("/", path="static", name="static")

    # SSL Context Configuration for HTTPS/WSS
    ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ssl_context.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)

    runner = web.AppRunner(app)
    await runner.setup()
    
    # Pass ssl_context to TCPSite
    site = web.TCPSite(runner, "0.0.0.0", HTTPS_PORT, ssl_context=ssl_context)
    await site.start()

    print(f"[HTTPS/WSS Server running at https://192.168.1.xxx:{HTTPS_PORT}/")   #Your server ip addr so that any other device on the LAN(browser capable) can access the site.

    await asyncio.Event().wait()

#Serve as http secured(https) to allows mic permission and access by Chrome and other browsers, or add the page to chrome://flag to trust unsecured dev site.
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[SERVER] Shutdown gracefully.")