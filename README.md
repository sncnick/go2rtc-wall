# Chickatrice go2rtc TV Wall

以 Docker Compose 部署的登入閘道、可拖拉 TV Wall 與 go2rtc 影音服務。網頁不提供原生 YAML 編輯器或任意命令輸入。

## 啟動

需要 Docker Engine / Docker Desktop 與 Compose v2。Node.js 24 僅用於本機開發；正式執行全部在 Docker。

首次建立本機設定（已有 `.env` 時不要重跑）：

```sh
# 有 Node.js 24 時
npm run setup
# 沒有 Node.js 時，改用 Docker 執行同一個初始化程序
# docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-alpine node src/cli.mjs setup
```

1. 編輯 `config/cameras.json`，格式見 `config/cameras.example.json`。來源只接受 `rtsp://` / `rtsps://`，主機須為私人 IPv4 或明確批准的公網 IPv4。攝影機密碼有特殊字元時使用 URL percent encoding；不接受 fragment、換行或 go2rtc 來源擴展。
2. 在 `.env` 設定 `MEDIA_HOST` 為 **Docker 主機的 LAN IPv4**，供 WebRTC ICE 使用。只有同一主機本機測試可以用預設 `127.0.0.1`。`CAMERA_HOST_ALLOWLIST` 是逗號分隔的公網 IP 清單，不允許網頁修改。
3. 建置及啟動：

```sh
docker compose up -d --build
```

4. 建立第一個正式管理員（互動輸入 14–128 字元密碼，不會顯示或放在 shell history）：

```sh
docker compose run --rm --no-deps gateway node src/cli.mjs user admin admin
```

5. 執行 `docker compose exec gateway node src/cli.mjs entrance` 取得私人登入網址。公開首頁只顯示存取受限。沒有預設帳號或預設密碼。

新增 viewer 或重設既有使用者密碼／角色：

```sh
docker compose run --rm --no-deps gateway node src/cli.mjs user operator viewer
```

同名更新會使該帳號所有 session 失效。管理員可看審計記錄；兩種角色均可觀看所有已批准的攝影機及管理自己的版面。管理員介面只提供「新增 RTSP」（名稱＋網址），不顯示詳細設定或原始 YAML；帳號管理仍限主機終端操作。第一版未包含 MFA、OIDC 或逐攝影機 ACL。

## 播放及轉發

每格右上角可切換 WebRTC、MSE、FLV、RTSP。版面、位置、大小及播放方式儲存在各使用者的 SQLite 記錄。拖拉標題移動，右下角調整大小；方向鍵移動，Shift + 方向鍵縮放；另有 2×2、3×3 和主畫面預設。

| 模式 | 實作 | 相容性與權限 |
|---|---|---|
| WebRTC | 登入後 SDP 交換，DTLS/SRTP 媒體 | 需可到達 Docker 主機 8555 TCP/UDP；編碼由瀏覽器協商 |
| MSE | 登入 WebSocket → fMP4 → MediaSource | H.264 常見；H.265 取決於瀏覽器／硬體 |
| HTTP-FLV | 受 session 保護的 FLV endpoint + 本機 mpegts.js | 建議 H.264/AAC；不把 FLV URL 變成匿名公開分享 |
| RTSP relay | 只讀 TCP 協定閘道 → go2rtc | VLC / NVR 等外部播放器，帳號 `relay`，使用 `.env` 的獨立 `RTSP_PASSWORD` |

RTSP 連線格式是 `rtsp://HOST:8554/CAMERA_ID`；在 VLC 輸入帳號密碼並使用 RTSP over TCP。預設只綁定 `127.0.0.1`。要給 LAN NVR 使用，在 `.env` 設 `RTSP_BIND_ADDRESS` 為主機 LAN 位址，再重新建立 gateway。不要把原生 go2rtc 的 1984 或 8554 直接公開。

RTSP 共享整合帳密與 Web 帳號分開，無逐使用者權限，適合受信任 NVR。只讀閘道拒絕 ANNOUNCE、RECORD、任意 query、任意來源與 UDP SETUP。原生 RTSP 並非加密傳輸，遠端使用 VPN。改動 RTSP 密碼後重建 go2rtc 及 gateway 以中斷舊連線。

**這些模式主要是轉封裝／轉發，不會自動把 H.265 重新編碼成 H.264。** 此版為消除任意指令入口，不啟用 FFmpeg／exec。需要轉碼時，應另加固定參數的轉碼 worker，再把其 RTSP 輸出加入清單；不能直接開放 `ffmpeg:` 或命令文字欄位。HLS、錄影、雙向對講不在此版範圍。

## LAN / HTTPS

預設入口只供主機本機使用。跨主機請用 HTTPS 反向代理：

- 在 Docker 主機安裝／配置 Caddy，參考 `deploy/Caddyfile.example`。
- 設 `APP_ORIGIN=https://wall.example.com`，不得加尾斜線或路徑。
- 保留 `BIND_ADDRESS=127.0.0.1`，由同主機 Caddy 代理到 8080。
- `MEDIA_HOST` 設主機 LAN IPv4；VPN 或 NAT 的 ICE 候選與防火牆須按實際網路配置。
- 非 localhost 的 HTTP origin 會拒絕啟動。HTTPS 使用 Secure + HttpOnly + SameSite=Strict 的 `__Host-` cookie。
- 閘道只信任設定的 Host / Origin；X-Forwarded-For 只在精確列出的可信代理來源才會使用，詳見下方 IP 記錄說明。

## 設定更新與維運

首次啟動會從 `config/cameras.json` 匯入播放來源到 SQLite；之後管理員透過「新增 RTSP」加入，來源會持久化並於 go2rtc 重啟後在 15 秒內重新套用。原始清單之後不會覆蓋資料庫；第一版沒有網頁修改／刪除來源。

部署參數或公網 IP allowlist 更新後：

```sh
docker compose run --rm --no-deps config-init
docker compose up -d --force-recreate go2rtc gateway
docker compose ps
```

生成程序驗證失敗時不會覆寫既有 go2rtc 設定。閘道也在啟動時重新驗證清單。`.env`、攝影機 URL、SQLite、生成的 go2rtc 設定均屬敏感資料。前端只收到 ID / 名稱，不會收到來源網址或密碼。不要把這些資料提交到 Git。備份 `wall-data` volume 前先停止 gateway，確保 SQLite WAL 完整；啟動設定可從原始清單及 `.env` 重建，網頁新增來源則必須備份 SQLite。

```sh
docker compose logs --tail 100 gateway go2rtc
docker compose stop
# 保留資料的移除方式（不要加 -v，除非確定要刪除帳號與版面）
docker compose down
```

## 安全邊界

- scrypt 密碼雜湊、固定長度隨機 session token（資料庫只存 SHA-256）、8 小時絕對期限、單帳號單 session、登入限速及併發上限。
- Origin + CSRF 驗證；瀏覽器只可選清單中的 stream ID。沒有一般用途反向代理。
- MSE 僅接受一次 `mse` codec 訊息；不轉發任意 WebSocket 訊息。MSE／FLV 每 5 秒檢查 session，失效後關閉。
- WebRTC 媒體直接連 go2rtc，Web session 撤銷不能強制終止惡意客戶端已建立的 peer connection。正常 UI 每 30 秒檢查 session 並關閉；要強制終止所有 WebRTC 媒體需重啟 go2rtc。這是此版已知限制。
- go2rtc 模組及 API allowlist；禁止 exec/echo/expr/ffmpeg/debug；不公開設定編輯／重啟／通用 streams API。內部 `/api/streams` 僅由閘道讀取及 PATCH 已驗證來源，不寫原生設定檔。
- go2rtc 使用 scratch 映像，無 shell、FFmpeg、套件管理器。全部服務非 root、唯讀 rootfs、cap_drop ALL、no-new-privileges、PID／記憶體限制，不掛 Docker socket、宿主機開機目錄或裝置。
- 網頁服務只可寫資料庫 volume；go2rtc 設定唯讀。審計最多保留 10,000 項並輸出容器 log，不是防竄改的外部審計系統。
- 容器隔離不是「絕不可能 RCE」保證。仍需更新映像、限制網路、維護主機。RTSP redirect 及媒體解析由上游處理；來源清單不是完整 egress firewall，部署時應限制攝影機 VLAN／可連目的地。

## 開發與測試

```sh
npm ci
npm test
```

測試包含未登入、登入限速、跨來源、CSRF、角色與版面隔離、危險來源拒絕、禁止原生 API、管理員新增來源與持久化、固定 SDP 路徑、FLV 代理、MSE 訊息限制與 session 撤銷、RTSP 禁止推流。

`scripts/preview.mjs` 是獨立的 UI 測試工具，使用臨時資料庫和明確的測試帳號，只綁 localhost:8081，不會複製進 Docker 映像；它預期合成 go2rtc 來源在 localhost:11984。正式服務永不建立這個測試帳號。

固定 go2rtc 1.9.15 及映像 digest；Node 基底也固定 digest。升級時須重新測試媒體協定及 allowlist，不只修改版本號。

上游依據：[安全設定](https://github.com/AlexxIT/go2rtc#security)、[1.9.15](https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.15)、[MSE 協定](https://github.com/AlexxIT/go2rtc/blob/v1.9.15/internal/mp4/ws.go)、[FLV](https://github.com/AlexxIT/go2rtc/blob/v1.9.15/internal/rtmp/rtmp.go)。

## 公開受限頁、隱藏入口及 IP 存取記錄

公開 `/` 現在回覆 403 存取受限頁，不含登入表單、按鈕、應用程式 JS 或隱藏路徑。舊的 `/login`、`/api/login`、`/app.js` 等直接路徑不公開。真正的入口是隨機路徑，所有登入 API、MSE、FLV 和靜態資源都在該路徑下。隱藏路徑只是額外遮蔽，不取代驗證，也不保證無法被發現。

查看自己的入口（不要貼到公開地方）：

```sh
docker compose exec gateway node src/cli.mjs entrance
```

首次 setup 會產生 `LOGIN_PATH`。既有安裝如未設定，會自動產生 160-bit 隨機入口並存入 SQLite，重啟不變。可在 `.env` 指定新的 `LOGIN_PATH=/至少24個隨機英數字或底線連字號/` 後重新建立 gateway。帳號密碼不變，原本的首頁書籤需更新。勿把私有入口放進 robots.txt、公開 sitemap 或公開監控 URL。應用程式回覆 `noindex` 與 `no-referrer`。

管理員登入後按「存取 IP」可看訪客 IP 摘要、最近 500 筆請求，並下載最多 50,000 筆 CSV。SQLite 最多保留 30 日／50,000 筆（以先到者為準），容器 JSON log 另有輪替上限。欄位包括 UTC 時間（UI 轉香港時間）、IP、socket peer、來源判定方式、方法、去除 query 的路徑、狀態、帳號與通道。狀態 0 代表開始／TCP 連線，499 代表 HTTP 中斷，101 代表 WebSocket 握手；RTSP CONNECT 不代表已通過帳密驗證。帳號欄也可能是登入失敗時所嘗試的名稱。

HTTP（包含未登入、404 掃描、登入成功／失敗）、WebSocket 握手及 RTSP TCP 連線會被記錄。WebRTC 8555 的直接媒體封包不是 HTTP 請求，不由此表追蹤；完整網路／封包來源須由路由器或防火牆記錄。不記錄密碼、Cookie、Authorization、請求 body 或 query；登入私有路徑在紀錄中替換為 `[entry]`。這些 log 不是防竄改的外部審計系統。

預設只採用 socket peer，**不信任**任意 `X-Forwarded-For`。若在反向代理後方，設定 `TRUSTED_PROXY_IPS` 為精確的 IPv4／IPv6 地址（逗號分隔，不接受全網 CIDR）。系統從 X-Forwarded-For 右端逐層略過明確信任的代理，遇到第一個非信任 IP 即停止；格式不合法時回退至 socket peer。此配置同時用於登入 IP 限速。

Docker Desktop、SNAT、VPN 或 router loopback 可能讓服務只看到閘道 IP。這不能從應用程式憑空還原。部署前應從另一個網路實測，核對 router 日誌、代理位址、`peer` 和 `ip_source`，再決定封鎖對象。**不要直接封鎖 Docker gateway、自己的反向代理或共享 NAT 位址，也不要把所有 403 都當作攻擊。** 本版只提供記錄及匯出，不自動變更 router 防火牆。

Caddy 作為直接對外的唯一代理時，會忽略不可信的來客 X-Forwarded-For；如經 CDN／多層代理，須另外設定 Caddy 的 trusted proxies，並限制 gateway 只能由可信代理到達。不能只因所有請求顯示同一個 Docker NAT IP，就把該 IP 標記可信而仍允許不受信任用戶直連 8080。詳見 [Caddy 官方反向代理文件](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。
