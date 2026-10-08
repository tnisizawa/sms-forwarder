# 開発者向け

## 接続設定

`.clasp.json.example` を `.clasp.json` にコピーし、自分のバインドスクリプト ID（`scriptId`）と
スプレッドシート ID（`parentId`）を設定します。`.clasp.json` はローカルだけに保持し、Git へ追加しません。

### 開発版と配布版

スクリプトは 2 つあり、どちらもスプレッドシートにバインドされています。

| 区分 | 何か | 接続ファイル |
|---|---|---|
| 開発版 | 手元で動作確認するためのスプレッドシート。普段の `clasp push` はここへ入る | `.clasp.json`（控えとして `.clasp-dev.json`） |
| 配布版 | README の「コピーリンク」の元になっているスプレッドシート。利用者はこれをコピーする | `.clasp-dist.json` |

- `.clasp.json` は常に開発版を指したままにします。配布版を `.clasp.json` にコピーして使うことはしません（戻し忘れると開発中のコードが配布版へ入るため）
- 配布版へ反映するときだけ、ファイルを明示して push します

```bash
clasp push                          # 開発版
clasp -P .clasp-dist.json push      # 配布版（バージョンを上げて開発版で確認した後だけ）
```

3 つの接続ファイルはいずれも ignore 済みです。スクリプト ID とスプレッドシート ID はリポジトリに書きません。

## 変更の流れ

```bash
npm test          # Node のユニットテスト（VM 上で gas/*.js を実行）
clasp push        # 開発版のバインドスクリプトへ反映（HEAD）
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
