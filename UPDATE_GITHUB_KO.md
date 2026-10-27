# NEON STRIKE v1.3.1 업데이트 방법

기존 Render 주소와 Neon `DATABASE_URL`은 그대로 유지합니다. ZIP 파일 자체를 GitHub에 올리지 말고, 아래 파일을 기존과 같은 경로에 업로드해 교체하세요.

## 필수 교체 파일
- 저장소 첫 화면: `index.html`, `package.json`, `README.md`
- `src/`: `main.js`, `style.css`, `shared-rules.js`
- `server/`: `index.js`
- `public/`: `sw.js`

각 폴더에서 **Add file → Upload files**를 누른 후 ZIP에서 해당 파일을 선택하고 **Commit changes**를 누릅니다. 기존 파일과 동일한 경로/이름을 사용해야 하며 `main(2).js`처럼 이름을 바꾸면 안 됩니다. `render.yaml`, `.gitignore`, Neon 연결 문자열은 수정하거나 삭제하지 마세요.

## 이번 보완
- BREACH SG 온라인 사격은 클라이언트가 랜덤으로 흩어진 첫 펠릿 방향이 아니라 카메라 중앙 조준 방향을 서버에 전송하고, 서버가 펠릿 산포를 독립 계산합니다.
- 1인칭 ORBITAL EDGE의 기존 콘 모양 중복 칼날을 제거하고, 넓은 각진 우주 칼날을 사용합니다.
- 재장전 때 탄창 분리/재삽입 구간, 왼손·팔과 오른손의 움직임을 추가했습니다.
- 무기별로 다른 기계식/전자식 리턴 클릭음을 덧붙였습니다.
- 서비스 워커 캐시 버전을 v16으로 올려 구버전 캐시를 지우게 했습니다.

참고: 이 프로젝트의 `rate` 값은 RPM이 아니라 한 발 사이의 초 단위 간격입니다. VIPER SMG는 0.12초, RAIL DMR은 0.32초 간격입니다.

## 테스트
개발 환경에서 `npm run check`와 `npm test`를 실행할 수 있습니다. 업데이트 후 Render에서 새 커밋이 `Live`가 되었는지 확인하고 브라우저에서 `Ctrl + Shift + R`을 눌러 캐시를 새로고침하세요. 실제 브라우저 빌드와 온라인 두 기기 플레이는 배포 후 직접 확인해야 합니다.

Render가 웹앱 로딩 전에 보여 주는 `Service waking up` 화면은 Render 플랫폼 화면이며, 게임의 HTML/CSS로 완전히 교체할 수 없습니다.
