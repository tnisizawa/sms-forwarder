# sms-forwarder

複数の Android 端末に届く SMS を、ひとつの Gmail アドレスに集約する。

端末1台だけでフィルターも要らないなら、SmsForwarder 単体のメール送信（SMTP）で足ります。
このプロジェクトが向くのは:

- 複数台の端末・複数 SIM をまとめて管理したい
- 送信元ごとの Gmail ラベルや、転送ルールのフィルターが欲しい
- 受信した SMS をスプレッドシートへ全件ログしたい
- スマホに Gmail のパスワード（アプリパスワード）を置きたくない

```
Android (SmsForwarder) --POST--> GAS Web アプリ --> Gmail 送信
                                     └-> スプレッドシート log / filter
```

このリポジトリの自作GASコードはMITライセンスです。SmsForwarderアプリは同梱しません。
アプリは別プロジェクトの配布ページから入手し、そちらのライセンスに従ってください。

## 3ステップで始める

1. [コピーリンク](https://docs.google.com/spreadsheets/d/1mE3G0dL7AGsBANXDy_07s1P8NrMJBeGb8vWYHwr2PFY/copy)を開き「**コピーを作成**」で自分のドライブへコピー
2. コピーしたスプレッドシートの「SMS転送」メニューから「**初期設定**」を実行し、権限を承認
3. ウェブアプリをデプロイして表示された URL を `settings` シートの「ウェブアプリURL*」へ貼り、
   「**スマホの設定手順をメールで送る**」を実行。届いたメールをスマホで開いて進める

詳しい手順: **[docs/setup.md](docs/setup.md)**

## フィルター（`filter` シート）

| type | field | pattern | memo |
|---|---|---|---|
| deny | from | ^0120 | フリーダイヤルからは捨てる |
| allow | body | 認証\|コード\|code | 認証系だけ通す |

- `type`: `allow` / `deny`、`field`: `from` / `body` / `device` / `sim`、`pattern`: 正規表現
- deny が先に評価され、一致したら捨てる
- allow 行が 1 つも無ければ全部通す。あれば allow に一致したものだけ通す
- 判定結果は `log` シートの `reason` 列に残る

## settings シート

| 項目 | 内容 |
|---|---|
| 合言葉* | スマホと共有する合言葉（自動生成。必須） |
| 転送先アドレス | 空欄なら自分宛 |
| ラベルの付け方 | SIM名 / 端末名 / 固定名 / 付けない |
| 固定ラベル名 | 「固定名」のときに使う |
| 親ラベル | SMS（空なら親ラベルなし） |
| ログの保持行数 | 1000（超過分は古い行から自動削除） |
| 未認証も記録する | いいえ（切り分け時だけ「はい」） |
| ウェブアプリURL* | デプロイ完了画面の公開 URL（必須） |

`*` は必須項目です。詳しい仕様は [docs/SHEETS_SPEC.md](docs/SHEETS_SPEC.md)。

## ドキュメント

- [初回セットアップ](docs/setup.md)
- [更新手順](docs/updating.md)
- [トラブルシューティング](docs/troubleshooting.md)
- [開発者向け](docs/development.md)
- [CHANGELOG](CHANGELOG.md)
- 運用・シート仕様の正本: [docs/OPERATIONS.md](docs/OPERATIONS.md) / [docs/SHEETS_SPEC.md](docs/SHEETS_SPEC.md)

## 関連プロジェクト

端末側アプリの候補:

- [SmsForwarder](https://github.com/pppscn/SmsForwarder) — 標準の端末側。Webhook で GAS へ POST できる
- [android_income_sms_gateway_webhook](https://github.com/bogkonstantin/android_income_sms_gateway_webhook) — 別の選択肢

シート記録止まりの GAS サンプル（フィルター・メール転送なし）:

- [android-sms-gateway/example-webhooks-google-sheets](https://github.com/android-sms-gateway/example-webhooks-google-sheets)
