# Energy Graph Scan iPhone v1.4.0

Mac/XcodeなしでiPhoneから使用できるSafari/PWA版です。

## 機能
- iPhoneカメラから直接撮影
- 写真ライブラリから画像選択
- 撮影時のEnergy per Bandガイド枠
- Energy per BandのAuto ROI
- ROIの手動位置調整
- Auto / Gain / Noise切替
- Low = Sample#0–270、High = Sample#270以降
- Channel未検出でもUnknownとして解析継続
- 複数Channel候補でも解析継続
- Gainは小数2桁、Noiseは小数4桁
- Gain High 1.00–1.50、Noise Low 0–0.015 / High 0.001–0.02のSpec判定
- 数値と同じ座標モデルでSample#270線・Low/High検出ラインを描画
- PWAキャッシュ対応。ホーム画面追加後はアプリ風に起動可能

## iPhoneでの使い方
1. GitHub Pages等のHTTPSサイトへこのフォルダを公開します。
2. iPhone SafariでURLを開きます。
3. 「共有」→「ホーム画面に追加」でアプリとして登録できます。
4. 「写真を撮る」でカメラを起動し、Channel欄とEnergy per Bandが入るよう撮影します。
5. 撮影後、自動ROIと解析が実行されます。
6. ROIがずれている場合は「ROI調整」を押し、赤枠をドラッグします。
7. 「Analyze」で再解析します。

## GitHub Pages
`.github/workflows/deploy-pages.yml`を同梱しています。GitHubのSettings → PagesでSourceをGitHub Actionsに設定後、workflowを実行してください。

## Windows v1.4.0との共通仕様
解析ロジックはWindows v1.4.0と同じ考え方で整理しています。ただしブラウザCanvas実装のためpixel extractionは別実装です。今後、実画像でWindows/iPhone双方の期待値を比較しながら閾値を揃える前提です。
