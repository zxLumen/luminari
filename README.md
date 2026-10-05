# Luminari · 生灵

访客创建自己的虚拟生灵,系统打分,全站按分排行 Top5;生灵沿主页四周游走、彼此对话、拥有记忆。

作为 zxLumen-Blog 的**独立子应用**(与 [Opentodo](https://github.com/zxLumen/Opentodo) / yijing64 / StockApp 同一套模式):
独立仓库 → 独立 GHCR 镜像 → 服务器独立容器 + 子域 `luminari.${DOMAIN}` → 博客应用栏一条
`openIn:'panel'` 的 iframe 入口。

## 功能

- **创建**:描述一只生物 → LLM 生成骨架(部件树)→ 浏览器端用真实渲染器出 PNG → 提交落库。
- **打分**:确定性启发式(两轴 craft/appeal + 11 维,见 `web/lib/creature/`)。**分只来自纯函数**,
  跨批次天然可比,不需要锚定。算法一变 `SCORE_VERSION` 递增,旧分不可比。
- **排行**:访客从自己 5 只里选 1 只参与排行;站长从全部生灵里手动精选 Top5(不受 5 只上限)。
  榜单按分排序,缓存过期时用视觉模型对 Top 边界做相邻成对精排(Davidson BT,失败自动退回纯分排序)。
- **面板**:底部 5 栏位 + 中央大预览(活体动画,拖动滑杆定格看「每天的样子」)+ 改名 +
  全部生灵点选加入/移出参排。
- **排行榜**:全站参与排行的生灵按分降序 Top100(名次 / 缩略图 / 名字 / 作者 / 分数 /
  提示词),点缩略图看大图预览。
- **四周生灵层**:Top5 + 我的 selected 生灵沿视口四周游走(活体 `RigCreature` 动画),头顶冒「想说的话」(LLM 生成,带记忆)。**此层只在主站(zxLumen-Blog)内联渲染,应用页不再显示**;应用侧仅提供数据接口 `GET /api/creatures/field`。

## 技术栈

Vite + React 19 + TypeScript(前端)· Node 原生 `http`(后端,`web/server.js`)· 单容器。

## 目录

```
web/
  server.js            # HTTP 服务 + 路由(生成/提交/榜单/对话/静态)
  lib/
    scope.js           # 访客 cid / 站长 SSO(zx_admin 验签)/ MOCK 身份
    creature-store.js   # 生灵数据(按数据域 JSON 文件)
    rank.js             # 跨域榜单汇总 + 缓存
    settings.js         # 每服务商一槽的 AI 配置(Key 只存服务端)
    llm.js / providers.js
    creature/           # ★ 评分引擎(从博客整批迁移,权威版)
    generate-prompt.ts  # 生成骨架的提示词
    creature-lib.js     # 生成/打分/出生名/对话 业务逻辑
    judge.js            # 视觉成对裁判 + BT 精排
  src/                  # React 前端(面板 / 排行榜 / 渲染器)
  server-dist/          # lib/**.ts 编译产物(server 运行时用)
```

## 本地开发

```bash
cd web
npm install
npm run dev            # API(8790)+ Vite(5174,代理 /api 到 8790)
```

首次进站长模式:访问 `http://localhost:8790/?owner=<token>`,token 见 `web/data/owner.token`
(或设环境变量 `LUMINARI_OWNER_TOKEN`)。在「设置」里配模型 provider / Key。

> Node ≥ 22(用到 `--env-file-if-exists`)。

### 批量生成 Admin 生灵(离线脚本)

```bash
cd web
npm run build && node server.js &        # 先起服务(需已配好 Key)
node scripts/seed-admin.mjs 30           # 生成 30 只(脚本内置 30 条富提示词),导出 data/top1.json
node scripts/seed-admin.mjs 30 --select  # 额外按分自动选 Top5(默认留给面板手动精选)
```

脚本用本机 **Chrome(CDP)** 打开 `render.html` 把每只渲染成 PNG(与前端同一个渲染器)。
描述取自脚本内 30 条精选富提示词(栖境 + 颜色 + 显著特征 + 性格),覆盖 8 类原型。
站长(`owner`)不受「每人 5 只」上限约束;默认**不**自动上榜,由站长在面板「我的生灵」里手动精选。

## 环境变量

| 变量 | 说明 |
|---|---|
| `LUMINARI_PORT` | 监听端口(默认 8790) |
| `LUMINARI_HOST` | 监听地址(默认 127.0.0.1;容器里设 0.0.0.0) |
| `LUMINARI_DATA_DIR` | 数据目录(默认 `web/data`) |
| `SESSION_SECRET` | 与博客同一把;用于验签博客下发的 `zx_admin` cookie(SSO) |
| `LUMINARI_OWNER_TOKEN` | 站长兜底 token(缺省在数据目录生成 `owner.token`) |
| `LUMINARI_VISITOR_AI` | `0` 关闭访客使用 AI |

## 部署(服务器侧)

与其它子应用相同:CI 构建镜像推 `ghcr.io/zxlumen/luminari-web`,服务器 `docker compose pull luminari`
后 `up -d`;Caddy 经 `luminari.${DOMAIN}` 反代到容器 `8790`。数据挂载 `luminari-data:/data`。

- Caddy 段需带 `Content-Security-Policy "frame-ancestors 'self' https://${DOMAIN}"`(会被博客 iframe 嵌入)。
- `SESSION_SECRET` 由 compose 的 `env_file: .env` 带入(与博客同一个)。

## 身份(SSO)

- **访客**:luminari 自签 `luminari_cid` cookie(子域下,与博客 `zx_cid` 不共享);站长可在博客开
  MOCK(`zx_mock`)后,该请求整体按普通访客处理。
- **站长**:信任博客下发的 `zx_admin`(= `<exp>.<hmac(exp, SESSION_SECRET)>`),同源子域共享。
