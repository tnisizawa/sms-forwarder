# 開発者向け

## 接続設定

`.clasp.json.example` を `.clasp.json` にコピーし、自分のバインドスクリプト ID（`scriptId`）と
スプレッドシート ID（`parentId`）を設定します。`.clasp.json` はローカルだけに保持し、Git へ追加しません。

開発版と配布版を分ける場合は `.clasp-dev.json` / `.clasp-dist.json` のように別ファイルで持ち、
使うときだけ `.clasp.json` へコピーします（どちらも ignore 済み）。

## 変更の流れ

```bash
npm test          # Node のユニットテスト（VM 上で gas/*.js を実行）
clasp push        # バインドスクリプトへ反映（HEAD = 開発版）
```

push しただけでは公開 URL に反映されません。公開デプロイへ載せるときは:

```bash
clasp deployments                    # デプロイ ID を確認
clasp deploy -i <deploymentId>       # 既存デプロイを新バージョンへ更新
```

「新しいデプロイ」は URL が変わるため、運用中は既存デプロイの更新だけを使います。

## 注意

- `clasp create` / `clasp pull` の直後は `appsscript.json` の `timeZone` が PC の滞在地に
  汚染されることがあります。`Asia/Tokyo` へ戻してから push してください
- バージョンを上げるときは `gas/lib.js` の `VERSION` と `CHANGELOG.md` を同じ番号で更新します
- コミットには実トークン・実 URL・スプレッドシート ID を含めません
