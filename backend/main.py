"""
极简聊天室 —— 后端

两个概念撑起整个项目：
    users     谁在用。昵称即身份，登录时不存在就自动创建。
    messages  谁 发给 谁、发了什么。消息落库，所以刷新后还在。

四个接口：
    POST /api/login       登录
    GET  /api/users       用户列表（用来"找到彼此"）
    POST /api/send        发消息
    GET  /api/messages     取某两人之间的消息（轮询用）

启动：python main.py    然后浏览器打开 http://127.0.0.1:8001
"""
import sqlite3#py数据库工具
import time#引用py时间工具，记录消息发送时间
from pathlib import Path#引用py路径工具，找文件

import uvicorn#引用服务器引擎，跑网页
from fastapi import FastAPI, HTTPException#接受前端请求
from fastapi.staticfiles import StaticFiles#引用给前端发文件的
from pydantic import BaseModel#引用数据校验工具，检验格式
#引入第三方库

BASE_DIR = Path(__file__).resolve().parent#找到本文件的绝对路径
DB_PATH = BASE_DIR / "chat.db"#指定数据库文件路径
FRONTEND_DIR = BASE_DIR.parent / "frontend"#指定前端文件路径，链接前后端

app = FastAPI(title="极简聊天室")#调用


# ---------------------------------------------------------------------------
# 数据库
#
# 用 sqlite3（Python 标准库自带）而不是 MySQL：不用装服务、不用配账号，
# 整个"数据库"就是项目目录下的 chat.db 一个文件。
# ---------------------------------------------------------------------------
def get_db() -> sqlite3.Connection:
    """开一个数据库连接。

    无参数。
    返回: sqlite3.Connection —— 调用方用完要自己 close()。

    row_factory 设成 Row，查询结果就能按列名取值（row["sender"]），
    不用记列的序号，列顺序改了也不会出错。
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """建表。IF NOT EXISTS 保证重复启动不报错、也不清掉已有数据。

    无参数、无返回值。模块被导入时执行一次。
    """
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE          -- 昵称不允许重复
        );

        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            sender     TEXT    NOT NULL,
            receiver   TEXT    NOT NULL,
            text       TEXT    NOT NULL,
            created_at INTEGER NOT NULL        -- 毫秒时间戳，由服务端生成
        );

        -- 每次轮询都要按 sender/receiver 过滤，建个索引
        CREATE INDEX IF NOT EXISTS idx_pair ON messages (sender, receiver);
        """
    )
    conn.commit()
    conn.close()


init_db()
# 请求体的格式。FastAPI 会拿这些类自动校验前端传来的 JSON，
# 字段缺了或类型不对会直接返回 422，不会进到我们的函数里。
class LoginIn(BaseModel):
    """登录请求体。"""
    name: str          # 昵称，就是前端输入框里的内容


class SendIn(BaseModel):
    """发消息请求体。"""
    sender: str        # 发送者的昵称
    receiver: str      # 接收者的昵称
    text: str          # 消息正文


# 四个接口，组成：装饰器 → 函数 → 校验 → 数据库 → 返回
@app.post("/api/login")#登录接口，前端输入昵称后点击登录按钮会触发这个接口
def login(body: LoginIn):
    """登录。昵称不存在就创建。
    参数 body: LoginIn，只含一个 name 字段，即用户输入的昵称。
               首尾空格会被去掉；全是空格的话返回 400。
    返回:      {"name": 昵称}

    最小实现，代价是任何人都能输入别人的昵称冒用。
    """
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="昵称不能为空")

    conn = get_db()
    row = conn.execute("SELECT name FROM users WHERE name = ?", (name,)).fetchone()
    if row is None:
        conn.execute("INSERT INTO users (name) VALUES (?)", (name,))
        conn.commit()
    conn.close()
    return {"name": name}


@app.get("/api/users")
def list_users(me: str = ""):
    """列出所有用户，排除自己。前端拿它渲染左边的联系人列表——这就是"找到彼此"。

    参数 me: 我的昵称（查询串里传，如 /api/users?me=alice）。
             列表里会把这个人过滤掉，因为不需要跟自己聊。
    返回:    [{"name": 昵称}, ...]，按昵称排序
    """
    conn = get_db()
    rows = conn.execute(
        "SELECT name FROM users WHERE name != ? ORDER BY name", (me,)
    ).fetchall()
    conn.close()
    return [{"name": r["name"]} for r in rows]


@app.post("/api/send")
def send(body: SendIn):
    """发一条消息给指定的人。写进数据库，所以刷新页面后还能读出来。

    参数 body: SendIn，含三个字段——
               sender   发送者的昵称
               receiver 接收者的昵称
               text     消息正文，去掉首尾空格后不能为空，否则返回 400
    返回:      {"status": "ok"}
    """
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="消息不能为空")

    conn = get_db()
    conn.execute(
        "INSERT INTO messages (sender, receiver, text, created_at) VALUES (?, ?, ?, ?)",
        (body.sender, body.receiver, text, int(time.time() * 1000)),
    )
    conn.commit()
    conn.close()
    return {"status": "ok"}


@app.get("/api/messages")
def get_messages(me: str, peer: str, after: int = 0):
    """取"我"和"peer"之间的消息。

    参数 me:    我的昵称
    参数 peer:  对方的昵称
    参数 after: 我已经收到的最大消息 id，默认 0。
                只返回比它新的，这样轮询每次只传新消息，不用把整段聊天记录重拉一遍。
                after=0 表示拉全部——打开会话载入历史时用。
    返回:       [{"id":, "sender":, "text":, "created_at":}, ...]，按 id 升序

    WHERE 里的两个 OR 条件是为了把"我发给他的"和"他发给我的"都算进来，
    因为一条消息只记了发送方，方向要从两边分别匹配。
    """
    conn = get_db()
    rows = conn.execute(
        """
        SELECT id, sender, text, created_at
        FROM messages
        WHERE id > ?
          AND ((sender = ? AND receiver = ?)
            OR (sender = ? AND receiver = ?))
        ORDER BY id ASC
        """,
        (after, me, peer, peer, me),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# 托管前端
# 把 frontend 目录也挂在同一个服务上，这样只启动一次、只开一个端口。
# 前端页面和接口同源，浏览器就不会触发跨域限制（CORS）。
# 这一行必须放在所有 /api 路由后面：FastAPI 按注册顺序匹配，
# 写在前面的话 "/" 会把包括 /api/... 在内的所有请求都吃掉，接口全变 404。
# html=True 表示访问 / 时自动返回该目录下的 index.html。
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8001)#作用是启动一个本地服务器，监听8001端口
