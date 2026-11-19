"""Render the public architecture diagrams as dependency-light PNG files.

Only Pillow and an installed sans-serif / CJK font are required. Coordinates are
for a 1440px-wide canvas; output is rendered at 2x and downsampled once.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
S = 2
W = 1440
BG = "#F8FAFC"
INK = "#15243A"
MUTED = "#5B6B80"
BLUE = "#3468C0"
CYAN = "#DFF5F6"
PALE = "#EEF4FF"
LINE = "#AFC2DC"
GREEN = "#24745A"
RED = "#B84949"
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
FONT = next((x for x in FONT_CANDIDATES if Path(x).is_file()), None)
assert FONT, "No usable CJK font found; adjust FONT_CANDIDATES."


def f(size, bold=False):
    # Songti index 2 is the regular face on macOS; bold is simulated by Pillow's
    # stroke only for the small number of short diagram headings.
    return ImageFont.truetype(FONT, size * S, index=2 if FONT.endswith("Songti.ttc") else 0)


def canvas(h, title, subtitle):
    image = Image.new("RGB", (W * S, h * S), BG)
    d = ImageDraw.Draw(image)
    d.text((58*S, 34*S), title, font=f(30), fill=INK, stroke_width=1, stroke_fill=INK)
    d.text((58*S, 85*S), subtitle, font=f(19), fill=MUTED)
    d.line((58*S, 125*S, (W-58)*S, 125*S), fill=LINE, width=1*S)
    return image, d


def txt(d, xy, text, size=22, fill=INK, anchor="mm", bold=False):
    d.text((xy[0]*S, xy[1]*S), text, font=f(size), fill=fill, anchor=anchor,
           stroke_width=1 if bold else 0, stroke_fill=fill)


def box(d, x, y, w, h, title, lines=(), fill="white", accent=BLUE):
    d.rounded_rectangle((x*S, y*S, (x+w)*S, (y+h)*S), radius=14*S,
                        fill=fill, outline=accent, width=2*S)
    txt(d, (x+w/2, y+34), title, 25, bold=True)
    start = y+71 if len(lines) > 1 else y+h/2+25
    for i, line in enumerate(lines):
        txt(d, (x+w/2, start+i*30), line, 19, MUTED)


def arrow(d, a, b, fill=BLUE, width=3):
    a = tuple(v*S for v in a); b = tuple(v*S for v in b)
    d.line((a, b), fill=fill, width=width*S)
    import math
    angle = math.atan2(b[1]-a[1], b[0]-a[0])
    r = 10*S
    points = [b,
              (b[0]-r*math.cos(angle-.55), b[1]-r*math.sin(angle-.55)),
              (b[0]-r*math.cos(angle+.55), b[1]-r*math.sin(angle+.55))]
    d.polygon(points, fill=fill)


def save(image, name):
    image.resize((W, image.height//S), Image.Resampling.LANCZOS).save(OUT/name, optimize=True)


def lifecycle():
    im,d=canvas(440,"任务对象与证据关系","关联按阅读顺序排列；Grant 可按审批阶段独立核验，不先于所有 Ticket")
    stages=[(30,"Trigger","事件"),(255,"Ticket","持久工作"),(480,"Grant","独立授权"),(705,"Assignment","一次分派"),(930,"Report","结构化结果"),(1155,"Effect / Artifact","效果与产物")]
    for i,(x,title,sub) in enumerate(stages):
        final=i in (4,5)
        box(d,x,210,200,125,title,(sub,),CYAN if final else PALE,GREEN if final else BLUE)
        if i<5: arrow(d,(x+200,272),(stages[i+1][0],272))
    txt(d,(720,387),"对象关联不是固定签票顺序；Grant 可独立审批，Report 不能代替 Effect / Artifact。",21,RED)
    save(im,"08-task-lifecycle.png")


def invariants():
    im, d = canvas(700, "分开建模，通过显式关系协作", "≠ 不是“毫无关系”，而是“不能把一个对象当成另一个对象的证明”")
    box(d, 60, 166, 390, 175, "Project", ("资源、位置、版本与权限",), CYAN, GREEN)
    box(d, 990, 166, 390, 175, "Chat", ("需求、确认与交流",), PALE)
    arrow(d, (450, 253), (990, 253))
    txt(d, (720, 220), "MessageRef / Ticket 关联", 20)
    txt(d, (720, 286), "Chat 知道项目 ≠ Chat 获得访问权", 23, RED)
    box(d, 60, 416, 390, 170, "Agent", ("理解与提出行动",), PALE)
    box(d, 990, 416, 390, 170, "Host", ("设备、Worker 与执行环境",), CYAN, GREEN)
    arrow(d, (450, 501), (990, 501))
    txt(d, (720, 450), "Placement + Assignment + Lease", 20)
    txt(d, (720, 535), "Agent 能提出 ≠ Host 可以执行", 23, RED)
    txt(d, (720, 643), "实线箭头代表已建立的关联，不代表自动获得另一方的权限。", 21, MUTED)
    save(im, "01-invariants.png")


def system():
    im, d = canvas(820, "控制面与执行面", "中心保存唯一任务权威，Local Node 管辖本机执行和私有数据")
    box(d, 210, 150, 1020, 75, "Phone / Web / IM / Other Sources", ("已认证、版本化 Client API",))
    arrows = [(350, 225, 350, 270), (1090, 225, 1090, 270)]
    for x1,y1,x2,y2 in arrows: arrow(d,(x1,y1),(x2,y2))
    box(d, 155, 280, 1130, 205, "Concierge / Control Plane", (), PALE)
    labels = [(205,"Identity / Policy"),(475,"Ticket / Grant"),(745,"Assignment / Lease"),(1015,"Registry / Artifact index")]
    for x,title in labels:
        d.rounded_rectangle((x*S,360*S,(x+220)*S,435*S),radius=10*S,fill="white",outline=LINE,width=2*S)
        txt(d,(x+110,398),title,19)
    arrow(d,(720,550),(720,498))
    txt(d,(955,525),"Node 主动注册 ↑；中心下发 Assignment / Lease ↓",18,MUTED)
    nodes=[(90,"DSH Loom Plugin","复用 DSH Agent / Session"),(510,"Bare Host Agent","API / MCP / CLI"),(930,"Runtime Connector","模型与专用 Worker")]
    for x,title,sub in nodes:
        box(d,x,565,420,140,title,(sub,),CYAN,GREEN)
    box(d,230,741,980,52,"Report / ArtifactRef / Heartbeat  ↑     ·     大 Artifact bytes 尽量 Host 直达",(),"white",GREEN)
    save(im,"02-system.png")


def routing():
    im,d=canvas(510,"四类决策职责","意图判断不替代确定性权限与资源调度")
    specs=[
        (55,"1  Router / Eval","是否做、做什么","请求何种 Grant"),
        (390,"2  Project Scheduler","依赖、DAG、优先级","项目阶段与输入输出"),
        (725,"3  Resource Scheduler","Host、模型、位置、负载","形成 Placement"),
        (1060,"4  Host Agent","授权后启动与监控","上报、恢复与对账"),
    ]
    for i,(x,title,l1,l2) in enumerate(specs):
        box(d,x,180,325,200,title,(l1,l2),PALE if i<3 else CYAN,BLUE if i<3 else GREEN)
        if i<3: arrow(d,(x+325,280),(x+335,280))
    txt(d,(720,441),"模型可以提供意图与候选；Policy、库存、Grant、Lease 和 Effect 由确定性协议约束。",22,MUTED)
    save(im,"03-routing.png")


def memory():
    im,d=canvas(630,"记忆与技能审核","自动观察只能生成候选；用户确认、真实验证和当前 Grant 各自独立")
    steps=[(55,"HabitObservation","临时观察"),(380,"Candidate","可编辑的来源草案"),(705,"User Review","接受 / 拒绝 / 稍后"),(1030,"Memory / Skill","有作用域的保存")]
    for i,(x,title,sub) in enumerate(steps):
        box(d,x,210,250,140,title,(sub,),PALE)
        if i<3: arrow(d,(x+250,280),(steps[i+1][0],280))
    box(d,1030,410,250,130,"Verified Skill",("仅 Skill 需独立样例 / 回放证据",),CYAN,GREEN)
    arrow(d,(1155,350),(1155,410),GREEN)
    box(d,380,410,250,130,"Reject / Expire",("降低提醒或遗忘",),"white",RED)
    arrow(d,(505,350),(505,410),RED)
    txt(d,(720,155),"用户明确说「记住」可直接保存 Memory；只有自动观察必须先形成候选。",21,BLUE)
    txt(d,(720,585),"Saved Skill ≠ Standing Grant；再次执行仍需检查当下资源、路径和授权。",23,RED)
    save(im,"04-memory.png")


def deployment():
    im,d=canvas(730,"首版部署结构","Rust 管核心策略，Vue 复用领域视图，跨语言节点只共享版本化协议")
    box(d,60,155,420,120,"Vue 3 + TypeScript",("Web / PWA / Tauri Shell",),PALE)
    box(d,510,155,420,120,"Rust Concierge",("Policy / Registry / Lease / Store",),PALE)
    box(d,960,155,420,120,"Vue Adapter",("不直接读取中心数据库",),PALE)
    arrow(d,(480,215),(510,215))
    box(d,160,365,510,150,"DSH Loom Plugin",("TypeScript / JavaScript","Local Node / SessionRef / ArtifactRef"),CYAN,GREEN)
    box(d,770,365,510,150,"Bare Rust Host Agent",("Native API / MCP / CLI","Local Broker / Effect Ledger"),CYAN,GREEN)
    arrow(d,(680,275),(415,365))
    arrow(d,(760,275),(1025,365))
    box(d,340,590,760,80,"Runtime Connector：LLM / ComfyUI / 专用 Worker",("原语言保留；协议与能力声明显式化",),"white",GREEN)
    arrow(d,(415,515),(555,590),GREEN)
    arrow(d,(1025,515),(885,590),GREEN)
    save(im,"05-deployment.png")


def installation():
    im,d=canvas(610,"安装不等于授权","每个阶段都留下独立事实；前一步成功不会自动产生后一步")
    names=[("Built","包已构建"),("Installed","文件已安装"),("Activated","组件已启用"),("Registered","节点已配对"),("Granted","任务取得授权")]
    xs=[40,320,600,880,1160]
    for i,((title,sub),x) in enumerate(zip(names,xs)):
        box(d,x,205,240,145,title,(sub,),PALE if i<4 else CYAN,BLUE if i<4 else GREEN)
        if i<4: arrow(d,(x+240,277),(xs[i+1],277))
    txt(d,(720,420),"≠ 贯穿全部阶段：Registered ≠ Granted，Activated ≠ Trusted",26,RED)
    txt(d,(720,483),"Rollout 只针对明确目标；Bootstrap 使用固定、受审计 Installer，而不是模型临时拼出的 Shell。",22,MUTED)
    txt(d,(720,537),"Unknown 安装结果进入对账 / Needs Person，不能无条件重装。",22,MUTED)
    save(im,"06-installation.png")


def recovery():
    im,d=canvas(740,"副作用与未知结果","回执丢失不能推翻已发生的效果；恢复先查证，再决定下一步")
    steps=[(80,"queued","持久意图"),(390,"leased","有限期执行资格"),(700,"effect attempt","不可变 ID + 输入摘要"),(1010,"confirmed","字节 / ref / 远端证据")]
    for i,(x,title,sub) in enumerate(steps):
        box(d,x,170,290,140,title,(sub,),CYAN if i==3 else PALE,GREEN if i==3 else BLUE)
        if i<3: arrow(d,(x+290,240),(steps[i+1][0],240))
    box(d,700,400,290,130,"Unknown",("超时 / 断线 / 回执缺失",),"white",RED)
    arrow(d,(845,310),(845,400),RED)
    box(d,340,400,290,130,"Reconcile",("Host Ledger + 权威远端",),CYAN,GREEN)
    arrow(d,(700,465),(630,465),GREEN)
    arrow(d,(485,400),(485,330),GREEN)
    box(d,1010,400,290,130,"Needs Person",("敏感效果询问 / 不盲目重跑",),"white",RED)
    arrow(d,(1010,465),(930,465),RED)
    txt(d,(765,350),"不能证明是否成功",20,RED)
    txt(d,(720,630),"Unknown ≠ Failed；Reconciling 不走公共 Retry，敏感效果必要时交给用户决定。",24,RED)
    save(im,"07-recovery.png")


for fn in [invariants,system,routing,memory,deployment,installation,recovery,lifecycle]:
    fn()
print("Rendered 8 diagrams using", FONT)
