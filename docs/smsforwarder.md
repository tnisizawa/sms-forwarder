# SmsForwarder（無料・オープンソース）設定手順

MacroDroid が有料化したため、端末側はこちらを標準にする。

- GitHub: https://github.com/pppscn/SmsForwarder （BSD ライセンス、無料、広告なし）
- Play ストアには無い。Releases から APK を入れる（提供元不明アプリの許可が必要）
- 表示言語は 中国語 / 英語（設定で English に切替可）
- 転送先に Webhook があり、GAS の URL にそのまま POST できる

## 0. インストールと権限

1. https://github.com/pppscn/SmsForwarder/releases から最新の `SmsForwarder_x.x.x_universal.apk` をダウンロードして入れる
2. 起動 → 権限を許可（SMS 受信・読取、**電話**、通知の表示、電池最適化の除外）
   - 「通知の表示」は常駐通知を出すためのもの。許可しておく（拒否すると止められやすい）
   - 「通知へのアクセス（Notification listener）」は他アプリの通知を転送する用なので、SMS だけなら**不要**。求められてもスキップしてよい
   - **電話の権限が無いと SIM の判定（`[card_slot]`）が空になる**。SIM ニックネームでラベルを付けるには必須
   - Android 13 以降で「アクセスを拒否されました / 制限付きの権限」と出たら、設定 → アプリ → SmsForwarder → 右上「⋮」→「制限付き設定を許可」→ ロック解除 → もう一度権限を許可
3. 「General settings」→ **Device mark**（端末名）に `N` など識別名を入れる（GAS の `device`。メール本文に載る）
   同じ画面の **SIM1 / SIM2 の備考（Remark）** に各 SIM のニックネーム（1 文字など）を入れる（GAS の `sim` = Gmail ラベルになる）
4. Xiaomi / OPPO / Huawei 系は自動起動の許可も入れる

## 1. 送信チャンネル（Sender）を作る

「Sender」→「+」→ **Webhook**

| 項目 | 値 |
|---|---|
| 名前 | `gas-sms` など |
| Method | `POST` |
| Webhook server (URL) | GAS の Web アプリ URL（`.../exec`） |
| Web params | 下の 1 行 |
| Secret | 空のまま |

Web params（1 行で。`XXXX` は GAS の TOKEN に置き換える）:

```
token=XXXX&device=[device_mark]&sim=[card_slot]&from=[from]&body=[org_content]&received_at=[receive_time]
```

- `[from]` 送信元番号、`[org_content]` SMS 原文、`[device_mark]` 端末名、`[card_slot]` SIM スロット＋備考、`[receive_time]` 受信時刻 は SmsForwarder 側で置換される
- `[card_slot]` は「General settings」→ SIM1 / SIM2 の **備考（Remark）** に付けた名前が入る（例 `SIM1_a`）。GAS 側で備考部分 `a` だけを取り出して Gmail ラベルにする。備考が無ければ `SIM1` がラベルになる
- Web params が `key=value&...` 形式なら `application/x-www-form-urlencoded` で送られる（GAS 側はこの形式を受け付ける）
- 作成画面の「Test」ボタンで GAS に届くか確認できる（`log` シートに 1 行増え、Gmail に届く）

## 2. 転送ルール（Rule）を作る

「Rule」→「SMS」タブ →「+」

| 項目 | 値 |
|---|---|
| マッチ条件 | `All`（全部転送。フィルターは GAS 側でやる） |
| Sender | 上で作った `gas-sms` |
| SIM | 両方 |

保存して有効化（トグル ON）。

## 3. 動作確認

1. 別の電話から SMS を送る
2. Gmail に `[SMS] <番号> @<端末名>` が届く
3. スプレッドシート `log` シートに 1 行増える
4. 届かないとき
   - SmsForwarder の「Log」画面で送信結果を見る
     - `{"ok":false,"error":"unauthorized"}` → TOKEN の打ち間違い
     - 応答が HTML → URL が `/exec` でない
   - `log` シートに行があって `mailed` が `no` → GAS 側フィルターで落ちている（`reason` 列）

## 4. 複数台に増やすとき

- 「General settings」→「Backup & restore」で設定をファイルに書き出し、他端末で読み込む
- 読み込み後に **Device mark** だけ変える
- 権限・電池最適化・自動起動は端末ごとに手で許可し直す
