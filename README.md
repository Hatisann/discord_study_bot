# Discord Study Bot

Discordサーバー向けの学習記録ボットです。

## 機能

- `/study start` と `/study stop` で学習時間を記録
- `/study stats` で自分の累計、週間、レベル、称号を確認
- `/study leaderboard` でサーバー内ランキング表示
- `/study graph` で学習履歴のグラフURLを生成
- `/study link` でサブ垢をメインアカウントに紐付け
- `/study admin edit` で管理者が学習時間を修正
- 実績・経験値・週間24時間超え称号機能

## セットアップ

1. `studybot` フォルダへ移動
2. `npm install`
3. `.env` を作成し、`DISCORD_TOKEN` と `GUILD_ID` を設定
   - 必要に応じて `DATABASE_FILE=studybot-data.json` を追加します
4. `npm start`

## 使い方

- `/study start [user]`
- `/study stop [user]`
- `/study current [user]`
- `/study pause [user]`
- `/study resume [user]`
- `/study stats`
- `/study leaderboard`
- `/study graph`
- `/study link main:@user sub:@user`
- `/study unlink sub:@user`
- `/study admin edit user:@user seconds:60 reason:mistake`

- `/study start` は公開メッセージで通知されます。
- `/study pause` / `/study resume` で学習を一時停止・再開できます。

## 仕組みの変更

- ランキングはメンションではなくユーザー名で表示します
- サブアカウントの学習時間はサブ側では0分扱いになり、メインアカウントに合算されます
- 統計・ランキング・実績はサーバーごとに分けて集計されます
- `/study start` と `/study stop` の通知は全員が見える公開メッセージになります

## 常時稼働について

- このボットを「パソコンが起動していないときも動かす」には、ローカルPCではなくクラウドや常時稼働可能なサーバーにデプロイする必要があります。
- Railway、Heroku、Render、VPS、Azure などのホスティングサービスに配置すると、PCの電源に依存せず動作できます。

## Render と cron-job.org での運用

1. GitHub にリポジトリをプッシュします。
2. Render にログインし、New -> Web Service を作成します。
3. リポジトリを選択し、`Start Command` を `npm start` にします。
4. `Environment` に `DISCORD_TOKEN` と `GUILD_ID` を追加します。
5. `PORT` は Render 側で自動設定されるので、コード側では `process.env.PORT` を使っています。
6. `cron-job.org` で定期的に `https://<your-render-service>.onrender.com/health` を 5〜10 分ごとに叩くように設定すると、Render のアイドルスリープを防ぎやすくなります。

### 重要な点

- Discord bot は WebSocket 接続が必要なので、Render では Web Service として `PORT` で待ち受ける構成が簡単です。
- `cron-job.org` は単に `GET /health` を叩いてアプリを起こすために使います。
- このリポジトリには既に Express の健康チェックエンドポイントが追加されているので、Render で問題なく動かせるはずです。
