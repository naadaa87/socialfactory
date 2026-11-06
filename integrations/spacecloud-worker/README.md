# 스페이스클라우드 자체 예약 연동 워커

홈페이지와 페이앱은 기존 서버를 사용하고, 스페이스클라우드 호스트 화면의 외부예약 등록·해제만 별도 상시 실행 프로세스가 처리합니다. 유료 중개 서비스는 사용하지 않습니다. 로그인 화면과 캘린더의 DOM만 조작하며 비공개 API 호출, 사용자 Chrome의 쿠키 추출, 비밀번호 저장 코드는 없습니다.

현재 코드는 **운영 비활성 상태**입니다. 전용 브라우저 로그인, 환경 설정, 빈 시간대 생성·해제 검증을 완료한 뒤 운영을 켜야 합니다. Codex가 사용하는 현재 로그인 브라우저와 이 서버 전용 프로필은 별개입니다.

노트북·PC가 꺼져도 동작하려면 이 프로세스를 상시 켜진 클라우드 서버에서 실행해야 합니다. 기존 Cloudflare Pages 호스팅만으로 영구 실행 Chrome을 제공할 수는 없습니다. 이 폴더는 해당 서버에 올릴 배포물을 준비하며 새 유료 서버를 구매하거나 자동 개통하지 않습니다.

## 서버 조건과 설치

Node.js 22.9 이상과 Playwright가 지원하는 Linux를 사용합니다. 첫 로그인은 해당 서버의 GUI 또는 SSH X11 forwarding이 필요합니다. 자동 실행은 headless로 가능합니다. 서버 계정은 한 개의 워커 프로필만 사용하고, 다른 서버에서 같은 큐를 실행하더라도 서버 API의 방별 임대 잠금이 적용됩니다.

```sh
cd /opt/socialfactory/spacecloud-worker
npm ci
npx playwright install --with-deps chromium
cp .env.example .env
chmod 600 .env
```

`.env`에는 실제 홈페이지의 HTTPS 원점 `API_ORIGIN`, Pages와 동일한 32자 이상의 비밀값 `SPACECLOUD_WORKER_TOKEN`을 설정합니다. `SPACECLOUD_ALLOW_WRITES=false`를 유지합니다. 토큰·로그인 프로필은 Git, 홈페이지 정적 파일, 채팅에 올리지 않습니다.

Cloudflare Pages 쪽에는 `SPACECLOUD_SYNC_ENABLED=true`, 같은 `SPACECLOUD_WORKER_TOKEN`, 기존 페이앱 설정이 필요합니다. D1에는 `schema-upgrade-spacecloud-sync.sql`이 적용되어야 합니다. 브라우저가 없는 Pages 함수 자체에서 호스트 UI를 조작하지 않습니다.

## 첫 로그인과 읽기 전용 확인

서버 관리자 계정이 X11 forwarding을 허용하는 경우, 로컬 X 서버를 켜고 기존 SSH 별칭으로 접속합니다.

```sh
ssh -Y EXISTING_SERVER_ALIAS
cd /opt/socialfactory/spacecloud-worker
npm run login
```

열린 **서버 전용 브라우저**에서 호스트 계정으로 로그인하고 캘린더를 확인한 뒤 Ctrl+C로 종료합니다. 로그인은 큐를 가져오거나 외부예약을 변경하지 않습니다. 캡차나 추가 인증이 나타나면 사용자가 직접 완료합니다. 전용 프로필은 `SPACECLOUD_PROFILE_DIR`에만 남습니다.

```sh
npm run check
npm test
```

`check`는 1~5번룸의 계정·방 이름과 달력 구조를 읽기 전용으로 확인합니다. 생성·해제와 자정 경계가 검증되었다는 뜻은 아닙니다. 호스트 UI가 바뀌거나 로그인이 만료되면 작업은 확인 필요 상태로 멈추고 홈페이지 결제도 보류됩니다.

## 기존 Linux 서버의 systemd 실행

전용 `spacecloud` 계정을 만들고 소스는 `/opt/socialfactory/spacecloud-worker`, 로그인 프로필은 `/var/lib/spacecloud-worker/profile`에 둡니다. **로그인할 때부터 같은 계정과 같은 프로필 경로를 사용**해야 합니다. `/etc/socialfactory/spacecloud-worker.env`는 해당 서비스 계정만 읽을 수 있게 600으로 설정합니다. 예제 `.env`와 같은 값에 `SPACECLOUD_ALLOW_WRITES=true`를 넣는 것은 빈 시간 테스트 후 마지막 단계입니다.

`spacecloud-worker.service`의 사용자·경로·Node 실행 경로를 실제 서버에 맞춰 검토하고 `/etc/systemd/system/`에 설치합니다. `ProtectHome=true` 때문에 서비스 프로필을 사용자 홈에 두지 않습니다. Chromium 샌드박스를 켜므로 해당 서버의 사용자 네임스페이스 지원도 필요합니다.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now spacecloud-worker
sudo journalctl -u spacecloud-worker -f
```

이 명령은 운영 활성화 단계입니다. 이 저장소 작업만으로 서비스가 설치되거나 실행되지는 않습니다. 인증 만료, 큐 연결 실패, 확인 필요 상태는 관리 화면에서도 확인해야 합니다.

## Docker 대안

`Dockerfile`과 `compose.yaml`은 동일한 고정 버전의 Playwright 패키지와 공식 브라우저 이미지를 사용합니다. 프로필은 private Docker volume에 보존되고 외부로 여는 포트는 없습니다. 컨테이너는 root 대신 `pwuser`로 실행하며 재시작 정책은 `unless-stopped`입니다.

```sh
docker compose build
```

같은 동작을 `sh deploy.sh prepare`로 실행할 수 있습니다. 처음 실행하면 권한 600의 `.env`만 만들고 멈춥니다. 설정 후 다시 준비 명령을 실행하고 `sh deploy.sh login`, `sh deploy.sh check`, 검증 후 `sh deploy.sh start` 순서로 실행합니다. 스크립트가 로그인이나 쓰기 활성화를 자동으로 승인하지 않습니다.

Linux의 SSH X11 forwarding 세션에서 같은 전용 서버 계정으로 실행할 수 있으면 `DISPLAY`와 해당 계정의 `XAUTHORITY` 파일 경로를 설정하고 일회성 로그인 컨테이너를 실행합니다. 컨테이너의 `pwuser`가 Xauthority 파일을 읽을 수 있어야 합니다. GUI를 인터넷에 공개하는 VNC 서비스는 만들지 않습니다.

```sh
docker compose -f compose.yaml -f compose.login.yaml run --rm --no-deps spacecloud-worker
docker compose run --rm --no-deps spacecloud-worker node worker.mjs --check
```

로그인·빈 시간 테스트 후 `.env`의 `SPACECLOUD_ALLOW_WRITES=true`를 설정하고 실행합니다.

```sh
docker compose up -d
docker compose logs -f --tail=50
```

systemd와 Docker를 동시에 같은 프로필로 실행하지 않습니다. 호스트의 Chromium 샌드박스나 X11 환경이 맞지 않으면 자동으로 우회하지 않고 서버 환경을 먼저 조정해야 합니다.

## 처리 순서와 보수적인 실패 처리

1. 서버에서 예약 시간을 먼저 점유하고, 방 단위 임대가 있는 작업 한 개를 전달합니다.
2. 워커가 요청일과 전날의 최신 호스트 달력을 새로 읽습니다. 자정을 넘는 기존 예약도 충돌로 판단합니다. 다음날 분할 예약은 모든 날짜를 확인한 뒤 첫 등록을 시작합니다.
3. 외부예약 이름 `SFWEB:<예약번호>`, 메모 `홈페이지 예약 연동 · SFWEB:<예약번호> · YYYY-MM-DD`로 등록하고, 직접 추가한 예약이라는 표시·방·날짜·시각·이름·메모를 확인합니다.
4. 고객용 스페이스클라우드 화면도 전체 새로고침한 뒤 해당 시간의 `is-disabled`를 확인합니다. 그다음 서버에 완료를 보고하여 페이앱 요청이 발행됩니다.
5. 결제 직전 검증 작업은 같은 표식이 여전히 있고 다른 예약이 겹치지 않는지 다시 확인합니다. 확인 작업은 없어진 차단을 새로 만들지 않습니다.
6. 서버가 결제 실패·취소를 확정한 경우 해제 작업을 줍니다. 직접 추가한 예약과 정확한 표식·범위가 일치하는 항목만 삭제하고, 다른 예약이 남아 있으면 그 시간은 계속 막혀 있는 상태가 맞는지 확인합니다.

30분 단위는 호스트 등록 UI에서 검증되지 않아 자동 연동에서는 정시 단위만 받습니다. 시간은 임의로 반올림하지 않습니다. 자정을 넘으면 날짜별 항목으로 나눕니다. `24 시` 선택이나 날짜 UI가 지원되지 않는 경우 확인 필요 상태로 남기며 일부만 등록된 항목도 임의 삭제하지 않습니다. 운영 전 빈 시간에서 자정 경계를 별도 검증해야 합니다.

등록·삭제 직전에는 서버 임대를 다시 확인합니다. 타임아웃은 “실패해서 등록되지 않음”으로 간주하지 않습니다. 불명확한 결과는 `review`로 보고하고 점유를 유지합니다. 보고 응답만 유실된 경우 **같은 완료 보고만** 재전송하며 화면 변경은 재실행하지 않습니다. 임대가 만료된 작업은 서버에서 격리되므로 자동 중복 생성하지 않습니다.

스페이스클라우드 고객이 이전 화면에서 이미 진행 중이던 결제까지 외부예약 UI와 원자적으로 잠글 수 있다는 보장은 없습니다. 내부 동시예약은 DB와 방별 작업 잠금으로 막지만 두 서비스 사이의 최종 순간 충돌은 확인 필요 상태로 처리해야 합니다.

워커는 유휴 시 각 방의 오늘부터 30일 뒤까지 호스트 달력을 약 3분 간격으로 수집합니다. 서버에는 날짜·시각과 검증한 자체 표식만 보내며 고객 이름·전화번호는 보내지 않습니다. 기존 iCal 수집도 함께 사용합니다. 작업 직후 일정 수집은 완료 보고 뒤에 실행하여 늦은 수집이 결제 직전 확인 시각을 새롭게 보이게 하지 않습니다.

프로세스가 비정상 종료되어 프로필의 `.worker-lock`이 남으면 해당 프로필을 사용하는 프로세스가 모두 종료되었는지 먼저 확인합니다. 외부 예약과 관리자 확인 필요 항목을 대조한 뒤 잠금 디렉터리를 제거하고 재시작합니다. 잠금을 자동 삭제하거나 기존 외부예약을 일괄 삭제하지 않습니다.

구현 참고: [Playwright persistent context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [공식 Docker 안내](https://playwright.dev/docs/docker). 실제 호스트·고객 UI는 2026-11-06 읽기 전용 관찰과 이전 빈 시간대 생성·해제 테스트에서 확인한 구조를 기준으로 합니다. 이 새 워커 프로세스의 운영 종단 테스트는 아직 실행하지 않았습니다.
