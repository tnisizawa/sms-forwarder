# sms-forwarder

Android 端末に届いた SMS を GAS 経由で Gmail に転送する。

このリポジトリの自作GASコードはMITライセンスです。SmsForwarderアプリは同梱しません。アプリは別プロジェクトの配布ページから入手し、そちらのライセンスに従ってください。

```
Android (MacroDroid) --POST--> GAS Web アプリ --> Gmail 送信
                                   └-> スプレッドシート log / filter
```

- GAS: `gas/`（clasp で push。`.clasp.json` 参照）
- スプレッドシート: GAS にバインド済み（`.clasp.json` の `parentId`）
  - `log` シート: 受信した SMS を全件記録（転送した/しなかった の理由付き）
  - `filter` シート: 転送ルール（後述）
- 端末側の設定: `docs/smsforwarder.md`（無料・標準）/ `docs/macrodroid.md`（有料になったので参考）

## claspの接続設定

開発者は `.clasp.json.example` を `.clasp.json` にコピーし、自分のバインドスクリプトIDとスプレッドシートIDを設定します。接続設定はローカルだけに保持し、Gitへ追加しません。

公開URLとデプロイIDは各自のGASデプロイ画面で確認します。このリポジトリには記載しません。過去のGit履歴には旧接続IDが残るため、ファイルからの除去だけでは旧URLは無効になりません。

## 初回セットアップ（GAS 側）

1. `clasp open-script` で GAS エディタを開く
2. 関数 `setup` を実行 → 権限を承認（log / filter シート作成、TOKEN 生成）
3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」（実行ユーザー: 自分 / アクセス: 全員）
4. 表示された公開URL（末尾が `/exec`） をブラウザで開く
   → 自分宛に「[SMS転送] スマホ側の設定手順（トークン入り）」メールが届く（URL・TOKEN・貼り付け用 Web params 入り）
5. スマホでそのメールを開き、書いてある通りに SmsForwarder を設定する
   （メールを再送したいときは URL の末尾に `?resend=1` を付けて開く）

転送先を変えたいときは `settings` シートの「転送先アドレス」を変更します（空欄なら自分宛）。ラベルは「ラベルの付け方」で変更します。

## メールの形

- 件名: `[SMS] <送信元番号>`（端末名は入れない → 同じ番号からの SMS が 1 スレッドにまとまる）
- ラベル: GAS が自動で付ける（無ければ作る）。`settings` シートの「ラベルの付け方」でSIM名（既定）/ 端末名 / 固定名 / 付けないを切り替えます。Gmail 側のフィルターは使わない
- 本文: 送信元 / 端末 / SIM / 受信時刻 + SMS 本文

## フィルター（`filter` シート）

| type | field | pattern | memo |
|---|---|---|---|
| deny | from | ^0120 | フリーダイヤルからは捨てる |
| allow | body | 認証\|コード\|code | 認証系だけ通す |

- `type`: `allow` / `deny`
- `field`: `from`（送信元）/ `body`（本文）/ `device`（端末名）/ `sim`（SIM ニックネーム）
- `pattern`: 正規表現（大文字小文字は区別しない）
- deny が先に評価され、一致したら捨てる
- allow 行が 1 つも無ければ全部通す。1 つでもあれば allow に一致したものだけ通す
- 判定結果は `log` シートの `reason` 列に残る

## コード更新

```bash
python ~/.claude/skills/clasp/scripts/run_clasp_push.py --project .clasp.json
```

push しただけでは公開 URL に反映されない。`clasp deployments` で ID を確認し
`clasp deploy -i <deploymentId>` で既存デプロイを更新する（clasp スキル `references/deploy.md`）。
