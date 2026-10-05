/**
 * 极简聊天室 —— 前端
 * 消息怎么"实时"到达对方：轮询。
 * 每 2 秒调一次 /api/messages，把比 lastId 更新的消息取回来。
 */


let me = null;        // 我的昵称
let peer = null;      // 正在和谁聊
let lastId = 0;    

function $(id) {//$() 是一个函数，传入 id，返回页面上那个元素
    return document.getElementById(id);
}
// 页面初始化
// 昵称存在 localStorage 里，刷新页面不用重新输入
const saved = localStorage.getItem('chat-name');//getItem() 从 localStorage 里取出上次存的昵称
if (saved) {
    me = saved;
    enterChat();
}

$('login-btn').onclick = doLogin;//登录按钮点击时调用 doLogin() 函数
$('name-input').onkeydown = function (e) {
    if (e.key === 'Enter') doLogin();      // 昵称输入框按回车时调用 doLogin()
};
$('send-btn').onclick = sendMessage;//发送按钮点击时调用 sendMessage() 函数
$('logout-btn').onclick = function () {
    localStorage.removeItem('chat-name');   // 删掉存在浏览器里的登录状态
    location.reload();                       // 重新加载页面，于是回到登录界面
};
$('msg-input').onkeydown = function (e) {
    if (e.key === 'Enter') sendMessage();  // 消息输入框按回车时调用 sendMessage()
};

// ---------- 登录 ----------
/**
 * 把昵称发给后端，成功后进入聊天界面。
 * 无参数：昵称从输入框读。成功后存进 localStorage，刷新页面就不用重新输了。
 */
async function doLogin() {
    const name = $('name-input').value.trim();//trim() 去掉首尾空格.value=输入框内的东西
    if (!name) {
        alert('请先输入昵称');
        return;
    }

    const res = await fetch('/api/login', {//fetch() 发送 HTTP 请求，链接前后端
        method: 'POST',//method: 'POST' 表示这是一个 POST 请求
        headers: { 'Content-Type': 'application/json' },//告诉后端请求体是 JSON 格式
        body: JSON.stringify({ name: name })
    });

    if (!res.ok) {
        alert('登录失败，请确认后端已启动');
        return;
    }

    me = (await res.json()).name;//先转化成对象，再取出 name 属性，用.取用
    localStorage.setItem('chat-name', me);//存进 localStorage，刷新页面就不用重新输入了
    enterChat();
}

/** 切换到聊天界面，并开始轮询。无参数。 */
function enterChat() {
    $('login-view').classList.add('hidden');//隐藏登录界面
    $('chat-view').classList.remove('hidden');//显示聊天界面
    $('me-name').textContent = me;//显示我的昵称

    tick();                            // 先立刻跑一次，别等 2 秒，避免开始等2秒
    setInterval(tick, 2000);           // 之后每 2 秒一次
}

/** 每次轮询要做的事：刷新联系人列表 + 拉当前会话的新消息。 */
async function tick() {
    try {
        await loadUsers();
        if (peer) await loadMessages();//如果peer不为空，说明已经选中某个联系人，就拉取当前会话的新消息
    } catch (err) {
        // 后端挂了或断网时不要清空界面，等下一次轮询自动恢复
        console.warn('轮询失败：', err);//打印警告信息到控制台
    }
}

// ---------- 联系人列表----------
/**
 * 拉取除我之外的所有用户，渲染成左侧的联系人列表。
 * 无参数：我的昵称从全局变量 me 读。每 2 秒被 tick() 调一次。
 */
async function loadUsers() {
    const res = await fetch('/api/users?me=' + encodeURIComponent(me));//调用条件是当填入me时
    const users = await res.json();

    const list = $('user-list');
    list.innerHTML = '';//清空列表，重新渲染

    if (users.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '还没有其他人。再开一个窗口，用别的昵称登录试试。';
        list.appendChild(li);
        return;
    }

    users.forEach(function (u) {//遍历每个元素
        const li = document.createElement('li');
        li.textContent = u.name;             // 用 textContent，昵称里的标签不会被当成 HTML 执行
        if (u.name === peer) li.className = 'active';   // 正在聊的人高亮
        li.onclick = function () {
            openChat(u.name);                // 点击联系人时调用 openChat()，传入对方昵称
        };
        list.appendChild(li);//把联系人 li 元素加到 ul 里
    });//把用户列表渲染成左侧的联系人列表
}

// ---------- 打开某个人的会话 ----------
/**
 * 进入与某个人的会话。
 * @param {string} name 对方的昵称
 *
 * 换人时必须把 lastId 归零：否则会带着上一个人的游标去查，
 * 新会话里 id 比它小的历史消息会被全部挡掉。
 */
function openChat(name) {
    peer = name;
    lastId = 0;                              // 换人就重置游标，重新拉这个会话的全部历史
    $('chat-box').innerHTML = '';//清空消息区，重新渲染
    $('peer-title').textContent = '正在和 ' + name + ' 聊天';
    $('msg-input').disabled = false;//启用输入框
    $('send-btn').disabled = false;

    loadUsers();                             // 立刻刷新左侧的选中高亮
    loadMessages();// 立刻拉一次这个会话的历史消息
}

// ---------- 拉消息 ----------
/**
 * 拉取当前会话里比 lastId 更新的消息，追加到消息区，然后把游标推进。
 * 无参数：me / peer / lastId 都从全局变量读。
 */
async function loadMessages() {
    const url = '/api/messages'
        + '?me=' + encodeURIComponent(me)//？是查询参数的开始，后面是键值对，键值对之间用&连接
        + '&peer=' + encodeURIComponent(peer)
        + '&after=' + lastId;//after=lastId 表示只拉取比 lastId 更新的消息

    const res = await fetch(url);//调用条件是当 peer 不为空时，说明已经选中某个联系人，就拉取当前会话的新消息
    const msgs = await res.json();//拆包
    if (msgs.length === 0) return;//没有新消息就直接返回

    msgs.forEach(function (m) {
        appendMessage(m);
        lastId = m.id;                       // 游标前移，下次就不会重复拉这条
    });

    //const box = $('chat-box');
    //box.scrollTop = box.scrollHeight;        // 滚到底部，让最新消息可见
}

/**
 * 把一条消息画成一个气泡。
 * @param {object} m 消息对象，含 sender（谁发的）、text（内容）、created_at（时间戳）
 */
function appendMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';                          // 所有消息都先加上 msg
    if (m.sender === me) wrap.classList.add('mine'); // 如果是自己发的，再加一个 mine

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = m.sender;

    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = m.text;               // 同样用 textContent，防止 XSS

    wrap.appendChild(who);
    wrap.appendChild(body);
    $('chat-box').appendChild(wrap);//把消息气泡加到消息区
    const box = $('chat-box');
    box.scrollTop = box.scrollHeight;        // 滚到底部，让最新消息可见
}

// ---------- 发消息 ----------
/**
 * 把输入框里的内容发给当前会话对象。
 * 无参数：内容从输入框读，收件人从全局变量 peer 读。
 * 发完立刻拉一次消息显示出来，不等下一次轮询——否则自己发的消息要 2 秒后才出现，看起来像坏了。
 */
async function sendMessage() {
    const text = $('msg-input').value.trim();
    if (!text || !peer) return;

    $('msg-input').value = '';

    await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: me, receiver: peer, text: text })
    });

    await loadMessages();                    // 马上拉回来显示，不用等下一次轮询
}
