# NEON STRIKE — 장기 보존용 Neon PostgreSQL 연결 가이드

이 프로젝트 코드는 이미 `DATABASE_URL`을 통해 PostgreSQL에 연결합니다. 기존 Render 무료 DB 대신 Neon을 사용하려면 아래 단계대로 연결하세요. 비밀번호/연결 URL을 GitHub 코드에 넣지 마세요.

## 1. Neon 데이터베이스 생성

1. https://neon.tech/ 에서 가입하고 Console을 엽니다.
2. **New project**를 선택하고 이름을 `neon-strike-accounts`로 정합니다.
3. Render 웹 서버와 가까운 지역을 선택합니다(기존 Render 서비스가 Oregon이면 가능한 경우 US West/Oregon 근처).
4. 프로젝트가 만들어지면 **Connect**를 누릅니다.
5. 드라이버가 Node.js 또는 `node-postgres (pg)`로 선택되어 있는지 확인합니다.
6. **Pooled connection** 또는 호스트명에 `-pooler`가 포함된 연결 옵션을 선택하고 연결 문자열을 복사합니다. 연결 문자열은 보통 `postgresql://...`로 시작합니다.

## 2. Render 서비스에 연결 문자열 설정

1. https://dashboard.render.com/ 에 접속합니다.
2. **Web Service `neon-strike-fps`**를 엽니다(BluePrints 페이지 자체가 아니라 서비스 리소스).
3. 왼쪽 메뉴에서 **Environment**를 엽니다.
4. `DATABASE_URL` 항목을 찾고 **Edit**를 누릅니다. 없으면 **Add Environment Variable**로 추가합니다.
5. Key는 정확히 `DATABASE_URL`, Value에는 Neon에서 복사한 전체 PostgreSQL connection string을 붙여넣습니다.
6. 저장 후 **Save, rebuild, and deploy** 또는 표시되는 재배포 버튼을 누릅니다. URL을 채팅이나 GitHub 파일에 붙여 넣지 마세요. 이 URL에는 DB 비밀번호가 포함됩니다.

`render.yaml`에는 `DATABASE_URL: sync: false`가 있습니다. 기존 Blueprint에서는 `sync: false`가 기존 값을 자동으로 바꾸지 않으므로, 위에서 서비스 Environment 화면을 직접 수정해야 합니다. 그 뒤 Blueprint를 다시 동기화하더라도 Render가 해당 비밀 변수를 자동으로 덮어쓰지 않도록 하는 설정입니다.

## 3. 연결 확인

브라우저에서 `https://네-서비스-주소/healthz`를 엽니다. 정상 DB 연결 및 스키마 생성이 끝나면 다음과 비슷하게 보여야 합니다.

```json
{ "ok": true, "app": "NEON STRIKE", "accounts": "ready" }
```

`accounts`가 `unavailable`이면 Render의 **Logs**에서 `[accounts] PostgreSQL ready` 또는 연결 오류를 확인하세요. 연결이 성공하면 서버가 `ns_accounts`, `ns_sessions` 테이블을 자동으로 생성합니다. 회원가입 테스트 후 다른 브라우저/기기에서 로그인해 레벨과 XP가 남는지 확인하세요.

## 무료 플랜과 보존

Neon Free는 Render 무료 Postgres처럼 30일 뒤 만료되는 플랜이 아닙니다. 무료 compute는 5분간 비활성인 경우 scale-to-zero 상태로 멈출 수 있고, 월간 compute/네트워크/저장 용량 한도에 닿으면 해당 기간 DB 작업이 중단될 수 있습니다. 공식 문서의 현재 한도는 Neon Free plan 안내를 확인하세요: https://neon.com/docs/introduction/plans 및 https://neon.com/docs/manage/billing/quotas

무료 플랜이라고 데이터 손실 위험이 0이라는 뜻은 아닙니다. 중요한 계정 데이터는 Neon Console에서 제공되는 백업/스냅샷 기능을 확인하고 별도 정기 백업을 유지하세요. 상용 서비스나 손실을 허용할 수 없는 계정 데이터에는 유료 플랜과 검증된 백업을 권장합니다.

## 기존 Render DB에 이미 계정이 있는 경우

이전하기 전에 기존 DB가 아직 살아 있고 실제 사용자가 있다면 계정 데이터를 Neon으로 복사해야 합니다. 이 파일은 DB를 자동으로 마이그레이션하지 않습니다. 테스트 계정만 있거나 데이터가 없다면 새 Neon DB에 새로 가입하면 됩니다. Neon 확인 전에 기존 Render DB를 삭제하지 마세요.
