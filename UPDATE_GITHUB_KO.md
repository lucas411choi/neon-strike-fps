# NEON STRIKE — 장기 보존 DB 연결 업데이트

## 변경 파일
- `render.yaml`: `DATABASE_URL`을 `sync: false`로 변경. 이후 Blueprint 동기화가 DB 비밀값을 덮어쓰지 않음. 기존 Render DB 정의는 데이터 손실 방지를 위해 유지함.
- `server/index.js`: 계정 DB 연결 관련 로그/오류 문구를 외부 PostgreSQL(Neon) 기준으로 업데이트. 앱은 이미 `DATABASE_URL`로 PostgreSQL에 연결하므로 DB 드라이버를 추가할 필요가 없음.
- `README.md`: Neon 장기 저장 방식으로 문서 갱신.
- `NEON_DATABASE_SETUP_KO.md`: Neon 생성과 Render 환경 변수 설정을 단계별로 설명.

## GitHub에 적용
압축을 풀고 기존 저장소의 같은 경로에 파일을 올립니다. `render.yaml`, `server/index.js`, `README.md`는 교체하고, `NEON_DATABASE_SETUP_KO.md`는 새 파일로 추가합니다. ZIP 파일 자체는 올리지 마세요.

## 중요: DATABASE_URL은 직접 설정
1. Neon에서 Pooled connection string을 복사합니다.
2. Render Dashboard → 실제 `neon-strike-fps` Web Service → Environment → `DATABASE_URL` 값을 새 Neon 연결 문자열로 바꿉니다.
3. 저장하고 재배포합니다.
4. `/healthz`에서 `accounts: "ready"`인지 확인합니다.

`DATABASE_URL`에는 비밀번호가 들어 있습니다. GitHub, 코드, 스크린샷, 공개 채팅에 게시하지 마세요. 기존 Render DB에 계정 데이터가 있다면 이전 전까지 삭제하지 마세요. 자세한 절차는 `NEON_DATABASE_SETUP_KO.md`를 확인하세요.
