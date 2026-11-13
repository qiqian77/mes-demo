"""本地启动器：起一个静态服务并打开浏览器。Ctrl+C 停止。"""
import http.server
import os
import socketserver
import threading
import webbrowser

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

threading.Timer(0.8, lambda: webbrowser.open("http://localhost:%d/" % PORT)).start()

with socketserver.TCPServer(("", PORT), http.server.SimpleHTTPRequestHandler) as httpd:
    print("MES Demo 已启动： http://localhost:%d/   （Ctrl+C 停止）" % PORT)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
