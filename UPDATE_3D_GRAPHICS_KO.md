# NEON STRIKE v1.4.0 — 3D 그래픽 업데이트 적용 방법

이 업데이트는 기존 Render 서비스, Neon `DATABASE_URL`, 계정·XP API를 변경하지 않습니다. 기존 GitHub 저장소의 지정 파일만 같은 경로에 교체하세요. ZIP 파일 자체를 GitHub에 올리지 마세요.

## 업데이트 파일

- 저장소 첫 화면: `index.html`, `package.json`, `README.md`, `UPDATE_3D_GRAPHICS_KO.md`
- `src/`: `main.js`, `style.css`
- `public/`: `sw.js`
- `public/models/weapons/`: `pistol.glb`, `revolver.glb`, `smg.glb`, `shotgun.glb`, `rifle.glb`, `dmr.glb`, `sniper.glb`, `lmg.glb`, `burst.glb`, `knife.glb`, `README.md`
- `tests/`: `weapon-model-assets.test.js` (자동 검사 파일; 선택 사항이지만 함께 추가 권장)

## GitHub에서 업로드

1. ZIP을 PC에 다운로드하고 `모두 압축 풀기`를 선택합니다.
2. GitHub 저장소 첫 화면에서 `Add file → Upload files`를 눌러 루트 파일 4개를 업로드하고 `Commit changes`합니다.
3. `src` 폴더에서 `main.js`와 `style.css`를 업로드하고 커밋합니다.
4. `public` 폴더에서 `sw.js`를 업로드하고 커밋합니다.
5. 기존 `public/models/weapons` 폴더를 열고 새 ZIP의 `models/weapons` 안에 있는 10개 `.glb` 파일과 `README.md`를 업로드합니다. 폴더가 없으면 `public/models/weapons/README.md`를 `Create new file`로 먼저 만들어 폴더를 만든 다음 파일을 업로드합니다.
6. 기존 `tests` 폴더에 `weapon-model-assets.test.js`를 추가하고 커밋합니다.

파일 이름을 `(2)`로 바꾸지 말고 원래 이름을 그대로 사용하세요. 기존 `render.yaml`, `server/index.js`, `src/shared-rules.js`, `.gitignore`, `vite.config.js`는 이번 업데이트에서 교체할 필요가 없습니다. Render 환경변수 `DATABASE_URL`도 건드리지 마세요.

## 배포 후 확인

1. Render에서 `Live`가 될 때까지 기다립니다. 자동 배포가 시작되지 않으면 `Manual Deploy → Deploy latest commit`을 선택합니다.
2. 기존 게임 주소에서 `Ctrl + Shift + R`을 눌러 캐시를 새로고침합니다.
3. 훈련장에서 권총·리볼버·SMG·산탄총·소총·DMR·저격총·LMG·3점사 소총·칼을 각각 꺼내 모델이 표시되는지 확인합니다.
4. 친구와 온라인 방에 들어가 상대가 장착한 총기도 보이는지 확인합니다.
5. 로비의 `총기` 메뉴에서 큰 미리보기 모델이 회전하는지 확인합니다.

GLB 파일이 없거나 로드에 실패하면 기존의 프로시저럴 무기 모델로 되돌아가도록 처리되어 있습니다. 그러나 실제 브라우저의 렌더링과 두 기기 온라인 테스트는 배포 후 확인해야 합니다.
