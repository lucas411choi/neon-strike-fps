# NEON STRIKE v1.6.0 업데이트 적용 안내

이 업데이트는 기존 GitHub/Render 배포본에 적용하는 파일 묶음입니다. ZIP 자체를 GitHub에 올리지 말고, 압축을 푼 안의 파일을 같은 경로에 업로드해 주세요.

## 주요 변경

- 킬캠 안내는 처치당한 플레이어에게만 표시됩니다. 처치한 플레이어는 5초 동안 이동을 계속할 수 있습니다.
- 훈련장 사람 더미 처치에도 장착한 스킨의 킬 효과가 적용됩니다. 더미는 5초 뒤 다시 나타납니다. 과녁에는 킬 모션을 적용하지 않습니다.
- 총기는 맵에서 사실상 무제한으로 쏠 수 있으며, 거리가 멀수록 무기별 탄퍼짐으로 명중률이 낮아집니다.
- 연사할수록 반동 열과 조준선 상승이 누적됩니다. SMG/산탄총/LMG는 더 강하게, DMR/저격소총은 더 약하게 조정했습니다.
- 서버와 클라이언트의 무기 반동 설정을 맞췄습니다. 서버가 거리 산포를 적용하므로 클라이언트는 사격 방향의 기본 조준 벡터를 전송합니다.
- 라운드 보상을 소폭 줄였습니다: 승리 1,550 CR, 패배 950 CR, 처치 150 CR. 라운드 진행에 따라 승리 +250 CR, 패배 +150 CR, 처치 +25 CR씩 추가됩니다.
- 클래식 10종, 프라임 1 카람빗/저격소총, 핼러윈 권총/DMR/LMG의 모델 파일이 포함되어 있습니다.
- Prime 1 카람빗의 금빛 베기 잔상을 조금 더 은은하게 조절했습니다.

## GitHub에 업로드할 파일

| ZIP 내 경로 | GitHub 경로 | 작업 |
|---|---|---|
| `index.html` | 저장소 최상위 `index.html` | 교체 |
| `package.json` | 저장소 최상위 `package.json` | 교체 |
| `README.md` | 저장소 최상위 `README.md` | 교체 가능 |
| `src/main.js` | `src/main.js` | 교체 |
| `src/style.css` | `src/style.css` | 교체 |
| `src/shared-rules.js` | `src/shared-rules.js` | 같은 파일로 교체 |
| `src/store-catalog.js` | `src/store-catalog.js` | 같은 파일로 교체 |
| `server/index.js` | `server/index.js` | 교체 |
| `public/sw.js` | `public/sw.js` | 교체 |
| `public/models/weapons/*.glb` | `public/models/weapons/` | 기존 파일과 같은 이름이면 교체/누락 파일 추가 |
| `public/models/skins/*.glb` | `public/models/skins/` | 15개 모델 모두 업로드 |

각 폴더에서 **Add file → Upload files**를 누르고 해당 파일을 고른 뒤 **Commit changes**를 눌러 저장합니다. 파일 이름에 `(2)`를 붙이지 마세요. ZIP 안의 디렉터리 구조를 그대로 유지해야 합니다.

## 건드리지 말아야 할 것

- `render.yaml`은 이 업데이트 ZIP에 넣지 않았습니다. 현재 서비스의 배포 설정을 유지해 주세요.
- Render의 `DATABASE_URL` 환경변수는 삭제하거나 GitHub에 올리지 마세요.
- `.neon-strike-auth.local.json`, 비밀번호, 연결 문자열 등 개인 데이터는 업로드하지 마세요.
- `tests` 폴더는 추가하지 않습니다.

## 배포

1. GitHub에 파일을 모두 커밋합니다.
2. Render가 자동 배포하지 않으면 기존 서비스에서 `Manual Deploy → Deploy latest commit`을 선택합니다.
3. 배포가 `Live`가 된 후 게임 주소에서 `Ctrl + Shift + R`을 눌러 캐시를 새로고침합니다.
4. 온라인 대전에서 한 플레이어를 처치해 킬캠 표시 역할을 확인하고, 킬캠 5초 동안 처치한 플레이어가 움직이는지 확인합니다.
5. 훈련장에서 장착한 스킨으로 사람 더미를 처치하고, 더미가 5초 뒤 복귀하는지 확인합니다.
6. SMG/LMG 연사 시 조준선이 올라가고, DMR/저격소총의 연속 반동이 상대적으로 약한지 확인합니다.

## 검사 상태 및 제한

- JavaScript 문법 검사, 공유 경험치/피해 규칙 스모크 검사, 스킨 카탈로그 검사, 25개 GLB 파일 헤더/JSON 검사 및 HTML 중복 ID 검사를 수행했습니다.
- 이 작업 환경에는 npm 패키지가 설치되어 있지 않고 패키지 저장소 접속도 제한되어 있어, 전체 Vite 프로덕션 빌드와 두 기기 간 실시간 온라인 플레이는 여기서 실행하지 못했습니다. 배포 후 로그와 실제 게임에서 확인이 필요합니다.
