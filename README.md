# sms-forwarder

Android 端末に届いた SMS を GAS 経由で Gmail に転送する。

```
Android (MacroDroid) --POST--> GAS Web アプリ --> Gmail 送信
                                   └-> スプレッドシート log / filter
```

- GAS: `gas/`（clasp で push。`.clasp.json` 参照）
- スプレッドシート: GAS にバインド済み（`.clasp.json` の `parentId`）
  - `log` シート: 受信した SMS を全件記録（転送した/しなかった の理由付き）
  - `filter` シート: 転送ルール（後述）
- 端末側の設定: `docs/smsforwarder.md`（無料・標準）/ `docs/macrodroid.md`（有料になったので参考）

## 現在のデプロイ（2026-09-15 済み）

- Web アプリ URL: `https://script.google.com/macros/s/AKfycbxHiie1ZTOgSzq2LB-G4JIss8nH7LF7BK7ya62H0BCwyTv4h_gaQQdg0AY2wSWIA2Cn/exec`
- デプロイ ID: `AKfycbxHiie1ZTOgSzq2LB-G4JIss8nH7LF7BK7ya62H0BCwyTv4h_gaQQdg0AY2wSWIA2Cn`
- TOKEN: GAS エディタ「プロジェクトの設定」→「スクリプト プロパティ」で確認（ここには書かない）
- 動作確認済み: GET → `{"ok":true}`、不正トークン POST → `{"ok":false,"error":"unauthorized"}`

## 初回セットアップ（GAS 側・1 回だけ・済み）

1. `clasp open-script` で GAS エディタを開く
2. 関数 `setup` を実行 → 権限を承認
3. 実行ログに出る `TOKEN = ...` を控える（端末側で使う）
4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
   - 実行ユーザー: 自分
   - アクセス: 全員
5. 発行された `https://script.google.com/macros/s/.../exec` を控える
6. ブラウザでその URL を開き `{"ok":true,...}` が出れば OK

転送先を変えたいときはスクリプトプロパティ `MAIL_TO` に設定（未設定なら自分宛）。

## メールの形

- 件名: `[SMS] <送信元番号>`（端末名は入れない → 同じ番号からの SMS が 1 スレッドにまとまる）
- ラベル: SIM ニックネーム（`sim`）と同名の Gmail ラベルを GAS が自動で付ける（無ければ作る）。Gmail 側のフィルターは使わない
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
