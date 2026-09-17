# MacroDroid 設定手順（端末側）

> ※ MacroDroid は有料化したため参考扱いです。標準は SmsForwarder です（[../setup.md](../setup.md) 参照）。

無料版で足りる（マクロ 1 個）。

## 0. 事前準備

1. Play ストアから MacroDroid をインストール
2. 初回起動時に求められる権限を許可（特に **SMS**）
3. 設定 → 「電池の最適化を無視」を ON（Android の設定画面へ飛ぶので MacroDroid を「制限なし」にする）
4. Xiaomi / OPPO / Huawei 系は「自動起動」も許可

## 1. マクロを作る

「マクロを追加」→ 名前は `SMS→Gmail` など。

### トリガー

- 「SMS/コール」→「SMS受信」
- 送信元: 「すべての連絡先」（フィルターは GAS 側でやるので端末では絞らない）

### アクション

- 「接続」→「HTTPリクエスト」
  - メソッド: `POST`
  - URL: GAS の Web アプリ URL（`.../exec`）
  - Content type: `application/x-www-form-urlencoded`
  - 「パラメータ」タブ（Query ではなく Body 側のキー/値）に以下を追加

| キー | 値 |
|---|---|
| `token` | GAS の `setup` で出た TOKEN |
| `device` | 端末を区別する名前（例: `pixel-a`。手で入力） |
| `from` | `{sms_number}` |
| `body` | `{sms_message}` |
| `received_at` | `{system_date} {system_time}` |

  - 「リダイレクトをフォロー」を ON（GAS の exec URL は一度リダイレクトする）
  - タイムアウトは既定のまま

> JSON ボディではなく「パラメータ」を使うのは、本文に改行や引用符が入っても壊れないようにするため。
> GAS 側は JSON / form どちらも受け付ける。

### 制約条件

- なし（最初は全部送る）

## 2. 動作確認

1. 別の電話から SMS を 1 通送る
2. Gmail に `[SMS] <番号> @<端末名>` が届く
3. スプレッドシートの `log` シートに 1 行増える
4. 届かないときは [../troubleshooting.md](../troubleshooting.md) を見る（MacroDroid の「マクロログ」で HTTP 応答を確認するところは同じ）

## 3. 複数台に増やすとき

- MacroDroid の「マクロをエクスポート」で `.macro` ファイルを作り、他の端末でインポート
- インポート後に `device` の値だけ書き換える
- 権限（SMS・電池最適化・自動起動）は端末ごとに手で許可し直す
