# NEON STRIKE v1.3.0 — 브라우저 전술 FPS

Three.js, Express, Socket.IO, PostgreSQL(Neon 권장)으로 만든 PC/모바일 브라우저용 FPS 프로토타입. 독자적인 절차 생성 맵, 무기 모델, Web Audio 효과음을 사용합니다.

## 현재 기능

- 새 로비: 총기 / 상점 / 플레이 / 스킨 / 계정 탭. 총기·계정 탭은 사용 가능하며 상점·스킨은 개발 중 화면
- 계정: ID/비밀번호 회원가입·로그인, scrypt 해시 비밀번호, 서버 세션, 계정별 레벨 및 XP 저장. XP는 PostgreSQL에 저장하고 다른 기기에서도 로그인해 이어갈 수 있음
- 시작 전 맵 선택: 아레나, 경복궁 야외, 넓은 도시. 로비 배경은 3개 맵을 순환
- 훈련장: 정지 과녁과 사람 더미, 각각 누적 100 피해 후 3초 뒤 부활, 모든 무기 무료 선택
- 친구와 온라인 1대1: 방 코드, PC/모바일/크로스플레이 규칙, 첫 6라운드 승리, 라운드 결과 후 수동 다음 라운드 시작
- 네트워크 복구: WebSocket/폴링 대체 연결, 자동 재연결, 90초까지 일시 연결 끊김 복구, 전투 중 라운드 상태 보존
- 9종의 총기와 근접 칼, 구분되는 3D 모델 및 무기별 사격 사운드, 리볼버, 연사/반동/탄퍼짐, 소총/DMR 줌과 발사 후 자동 줌아웃 저격 스코프
- 사격 시 반동 방향 카메라 킥, 무기별 연사 제한, Shift로 조용히 걷기와 3D 보행 사운드
- 온라인 상대 피격 시 잠깐 붉게 번쩍이는 피드백과 hit marker; 데미지 숫자 팝업은 표시하지 않음
- 라운드 경제 및 경량/중량 보호막, 전투 중 상점 비활성화
- 모바일 가상 조이스틱/터치 조준/사격 및 홈 화면 추가용 PWA 메타데이터

## PC에서 실행

1. ZIP 압축을 풉니다.
2. Node.js 20.19 이상을 설치합니다.
3. `START_GAME.bat`을 더블 클릭하거나 프로젝트 폴더에서 `npm install` 다음 `npm run dev`를 실행합니다.
4. `http://localhost:3000`을 엽니다.

## 온라인 배포

모바일과 PC에서 같은 공개 HTTPS 주소를 엽니다. Render Blueprint 설정은 루트의 `render.yaml`을 사용합니다.

- Build: `npm install --include=dev && npm run build`
- Start: `npm start`
- Health check: `/healthz`

프로덕션 번들은 Vite `dist` 폴더를 서비스합니다. 서버는 Render `PORT` 환경 변수를 사용합니다.

## 장기 계정 저장소(Neon PostgreSQL 권장)

계정과 XP는 PostgreSQL에 저장합니다. Render의 무료 PostgreSQL은 생성 30일 후 만료되므로, 장기 저장에는 Neon을 권장합니다. Neon Free는 30일 만료형이 아니며 비활성 시 compute가 일시 정지할 수 있지만 데이터는 저장소에 남습니다. 무료 플랜은 1 GB/project와 100 CU-hours/project/month 등의 한도가 있으므로 한도를 넘으면 DB 작업이 일시 중지될 수 있습니다. 중요한 데이터는 정기적으로 백업하세요.

설치 단계는 `NEON_DATABASE_SETUP_KO.md`를 따르세요. 핵심은 Neon에서 **pooled connection string**을 복사해 Render 서비스의 `Environment`에 `DATABASE_URL`로 등록하는 것입니다. `render.yaml`에서는 `DATABASE_URL`을 `sync: false`로 두어 이후 Blueprint 동기화가 비밀 연결 문자열을 덮어쓰지 않도록 했습니다. 기존 Render Postgres 리소스 정의는 기존 데이터를 실수로 삭제하지 않도록 남겨 두었지만, Neon 연결이 확인되기 전에는 기존 DB를 삭제하지 마세요.

## 컨트롤

PC: WASD 이동, 마우스 시점/조준, 왼쪽 클릭 누르고 있기 사격(무기별 발사 속도), Shift를 누르면 조용히 걷기, Space 점프, R 재장전, 1 주무기 / 2 기본 권총 / 3 칼, 4–9 보유 무기 바로가기, 우클릭 또는 Q 줌 토글, Esc 메뉴. 훈련장은 `훈련 무기 선택` 또는 T로 무료 무기를 변경할 수 있습니다. 저격총은 발사 후 자동 줌아웃되며 다시 클릭하려면 마우스 버튼을 놓았다가 눌러야 합니다.

모바일: 가상 조이스틱, 오른쪽 화면 드래그 조준, FIRE/점프/재장전/줌 버튼 및 훈련장 무기 선택.

## 자동 테스트

`npm test`는 XP 레벨업/잔여 XP, 머리·몸통·다리 피해 배율, 사용자 ID/비밀번호 검증, 클라이언트와 서버의 무기 수치 일치, 연사/저격 릴리스 규칙을 확인합니다. 계정 XP 요청은 큐에 순차 처리하고, 다른 계정으로 전환한 뒤 도착한 이전 응답은 현재 프로필에 적용하지 않습니다. `npm run check`는 서버·클라이언트 JavaScript 문법 검사를 수행합니다.

## 검증 한계

이 작업 환경은 npm 의존성 설치가 시간 초과되어 프로덕션 번드 및 브라우저 렌더링 빌드를 실행하지 못했습니다. 실제 브라우저 렌더링과 2개 기기의 온라인 플레이는 배포 후 별도로 확인해야 합니다. 이 프로토타입은 전문 안티치트나 대규모 매칭을 포함하지 않습니다.


## v1.3.0 weapon patch

- Atlas Pistol 10 damage; Ironclad .45 30; Viper SMG 7 with slower fire cadence; Vantage AR 15; Rail DMR 20 with faster follow-up. Titan LMG and Longshot SR base damage remain unchanged.
- Breach SG fires 10 independently sampled pellets and damage falls off over distance.
- Ion Burst sends three paced, server-validated shots per trigger; sniper requires trigger release and has inaccurate hip-fire but precise scope aim.
- Added procedural draw, inspection (Enter), reload, recoil, hand/forearm and knife-swing animations; removed the minimap.
- The `rate` field is the interval in seconds between shots, so it is not a direct RPM/number-of-shots stat. Viper is slowed to 0.12 s per shot; Rail DMR is sped up to 0.32 s.


## v1.3.1 follow-up fix
- Online shotgun now sends center aim to the server; server creates its own pellet spread.
- Removed the overlapping cone blade from the first-person knife model.
- Added a clearer magazine-out / magazine-in sequence and support-hand movement during reload.
- Added weapon-specific mechanical return clicks to the procedural NEON firing audio.
- Service-worker cache bumped to v16.

The Viper SMG and Rail DMR rate values are shot intervals in seconds in this codebase, not numeric RPM. Viper uses 0.12s between shots; Rail DMR uses 0.32s between shots.
