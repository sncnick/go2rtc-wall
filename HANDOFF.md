# 接手指南

本專案是 **Node.js 24 登入／播放閘道 + go2rtc 1.9.15 + buildless JavaScript TV Wall**，以 Docker Compose 執行。先閱讀 README 的安全邊界；不要把原生 go2rtc 1984 直接對外公開。

## 從新機開始

```sh
git clone https://github.com/sncnick/go2rtc-wall.git
cd go2rtc-wall
# 有 Node 24 時
npm run setup
# 若沒有 Node，改用：
# docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-alpine node src/cli.mjs setup
```

編輯 `.env` 的 `MEDIA_HOST`（Docker 主機 LAN IP），跨機訪問還需配置 HTTPS 域名、反向代理及 `APP_ORIGIN`。可保持 `config/cameras.json` 是 `[]`，登入後新增 RTSP。公網 RTSP IP 須先加入 `CAMERA_HOST_ALLOWLIST`。

```sh
docker compose up -d --build
docker compose run --rm --no-deps gateway node src/cli.mjs user admin admin
docker compose exec gateway node src/cli.mjs entrance
```

建立帳號時兩次輸入相同的 **14–128 字元**密碼。沒有預設正式帳號／密碼。公開 `/` 故意顯示存取受限；最後一條指令會印出真正登入入口，需收藏。隱藏入口與所有本機 secrets 不在 repo 內。

## 升級既有部署

先備份 `.env`、`config/cameras.json` 和 **wall-data** volume。備份 SQLite 時停止 gateway，連同 WAL 一起備份或使用 SQLite backup API，不要僅複製運行中的單一 DB 檔。

```sh
git pull --ff-only
docker compose up -d --build --no-deps gateway
docker compose ps
```

本次分享功能以 `CREATE TABLE IF NOT EXISTS shares` 自動增加資料表；不改帳號、版面、來源、私人入口。`RTSP_PUBLIC_BASE` 是可選新環境變數。若同時改 `.env` 的 go2rtc 密碼／MEDIA_HOST 等引擎設定：

```sh
docker compose run --rm --no-deps config-init
docker compose up -d --force-recreate go2rtc gateway
```

不要執行 `docker compose down -v`，除非確定要刪帳號、來源、版面與分享。降版前保留備份；舊版本不提供分享路由，已發出的分享會無法播放。

## 功能與檔案

| 位置 | 責任 |
|---|---|
| `src/server.mjs` | Host/Origin、隱藏入口、session/CSRF、admin API、來源同步 |
| `src/store.mjs` | SQLite schema、scrypt、session token 雜湊、audit |
| `src/config.mjs` | RTSP 來源驗證、最小 go2rtc 設定生成 |
| `src/media.mjs` | 固定來源 MSE WebSocket、FLV 串流代理、每 5 秒授權檢查 |
| `src/shares.mjs` | 分享憑證、到期／撤銷、公開播放頁、連線上限 |
| `src/rtsp-proxy.mjs` | 只讀 RTSP TCP 閘道；阻擋推流及任意 query |
| `src/access.mjs` | IP 解析、可信代理邊界、存取紀錄與路徑遮蔽 |
| `public/app.js` | 管理員介面、拖拉 TV Wall、分享建立／複製／撤銷 |
| `public/share.*` | 不依賴登入 session 的獨立 MSE／FLV 播放頁 |
| `compose.yaml` / Dockerfiles | 非 root、唯讀容器、埠與 volume；go2rtc 無 shell |

## 分享 API（管理端均在私人入口前綴下）

- `GET api/shares`：admin 列出分享與 RTSP 地址，不傳回原始 token。
- `POST api/shares`：admin + CSRF，JSON `{camera,label,hours}`，hours 為 1／24／168／720；回傳一次性可見的播放頁、FLV、MSE、iframe。
- `POST api/shares/<id>/revoke`：admin + CSRF，撤銷分享。
- `GET /share/<token>/`：獨立播放器，預設 MSE，可切 FLV。
- `GET /share/<token>/info`：只回顯示名稱及期限。
- `GET /share/<token>/stream.flv`：HTTP-FLV，接受跨站無 Cookie 請求。
- `WS /share/<token>/mse`：go2rtc MSE 訊息協定；第一個訊息必須是 `{type:"mse",value:"逗號分隔的受支援codec"}`，只允許一次。

Token 是 256-bit 隨機值，SQLite 只存 SHA-256。連結只授權一個攝影機的 MSE／FLV，不授權 WebRTC signaling、RTSP 帳密、管理 API 或任意來源。所有有效持有人均可播放，這不是逐人驗證／防轉傳。

## 驗證

```sh
npm ci
npm test
docker compose build
docker compose up -d
docker compose ps
```

`test/shares.test.mjs` 驗證 admin/CSRF、來源範圍、跨站 CORS/MSE、token 雜湊與 log 遮蔽、過期及撤銷後關閉既有 FLV/MSE。其他測試覆蓋登入／限速、私人路徑、IP header 防偽造、RTSP 只讀限制、來源恢復。

`scripts/preview.mjs` 使用臨時 DB 和明確的測試帳號，只綁 localhost:8081；依賴 localhost:11984 的合成 go2rtc，不能視為正式部署。`docs/verification.md` 記錄實際完成的測試，避免把 mock 通道測試誤稱為所有攝影機相容性驗證。

## 必須保留的邊界／已知限制

- 不重新開放 exec、echo、expr、ffmpeg、debug、原生設定編輯器或一般用途反向代理。
- 本機 `.env`、真實攝影機 URL、DB、access CSV、畫面截圖不可提交。轉交實際憑證請另用安全管道。
- 分享 bearer URL 在代理／CDN access log 也需要遮蔽並禁止快取；不能只依賴應用程式的 log 遮蔽。
- HTTPS／外部 DNS／NAT／VPN 需按部署環境設定；localhost 分享不會令外部觀眾自動連到主機。
- Docker Desktop 可能只顯示 NAT IP。不要自動信任所有 X-Forwarded-For，不要把 NAT／反向代理 IP 當攻擊者封鎖。
- RTSP 為獨立共享帳密，需 TCP；Web 分享撤銷不影響 RTSP。無逐攝影機 RTSP ACL。
- WebRTC 已建立的直接媒體連線不會由 session 撤銷強制終止（正常 UI 會檢查）；分享端特意只提供可由閘道中斷的 MSE／FLV。
- 無重新編碼；H.265 取決於瀏覽器／硬體，FLV 建議 H.264/AAC。無 RTMP／RTMPS 主動推流、HLS、錄影、MFA/OIDC、自動 router block。
- 媒體解析漏洞／RTSP redirect 的 egress 邊界仍依賴上游及網路防火牆；此版不是完成滲透測試的公開直播 CDN。
- 未實作攝影機修改／刪除、逐觀看者 ACL、大規模流量測試或全面無障礙測試。

## 建議下一批工作

1. 按目標 NVR／網站／直播平台做端到端相容性及長時間負載測試。
2. 若要 YouTube／Facebook，加入獨立受限 worker，固定輸入及 RTMP(S) destination，不接受 shell 字串。
3. 若要轉碼，將固定 profile 轉碼與管理閘道隔離，不把 FFmpeg 任意參數傳給 go2rtc。
4. 完善攝影機 CRUD、分享列表分頁、告警與外部防竄改 audit；視需求增加 MFA/OIDC 及精確來源／觀眾權限。
