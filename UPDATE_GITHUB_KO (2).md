# GitHub 업데이트 가이드

1. ZIP 파일을 PC에서 압축 해제합니다. ZIP 자체를 GitHub에 올리지 않습니다.
2. 기존 저장소에서 각 폴더를 연 후 `Add file → Upload files`로 같은 이름의 파일을 업로드합니다.
3. 아래쪽 `Commit changes`를 누릅니다. 같은 경로·같은 이름이면 기존 파일의 새 버전으로 교체됩니다.
4. 파일을 모두 저장한 뒤 Render의 `Deploys` 화면에서 최신 커밋이 배포되는지 확인합니다. 자동 배포가 시작되지 않으면 `Manual Deploy → Deploy latest commit`을 선택합니다.

이번 버전에서 교체할 파일은 `index.html`, `package.json`, `README.md`, `src/main.js`, `src/style.css`, `server/index.js`, `public/sw.js`입니다. `render.yaml`, `src/shared-rules.js`, `src/store-catalog.js`, `.gitignore`와 Render의 `DATABASE_URL`은 그대로 유지하세요.

`DATABASE_URL`에는 Neon의 비밀 연결 문자열이 포함됩니다. GitHub 코드에 올리지 마세요.
