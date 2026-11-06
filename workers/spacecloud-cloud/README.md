# 소셜팩토리 클라우드 예약 연동

이 Worker는 Cloudflare Browser Run에서 스페이스클라우드 UI 작업을 수행합니다. 노트북이나 매장 PC가 꺼져 있어도 Cloudflare의 예약 실행에서 돌아갑니다. 기존 `integrations/spacecloud-worker`의 방·날짜·고유 표식 검증을 재사용하며 브라우저를 계속 열어 두는 서버는 필요하지 않습니다.

기본 구성은 **비활성**입니다. 이 폴더를 만들거나 `npm run dry-run`을 실행하는 것만으로 클라우드 리소스·구독·브라우저가 생성되지는 않습니다.

## 비용 확인과 예산

- Workers Free의 Browser Run은 하루 10분이며, 한도 초과 시 새 세션 생성이 429로 거절됩니다. 무료 모드의 자체 예산은 하루 최대 9분입니다.
- Workers Paid는 월 10시간의 브라우저 사용이 포함되고 초과 사용은 시간당 $0.09입니다. Workers 구독은 계정당 최소 월 $5이며, 기존 유료 계정의 포함량을 사용하는 것과 새 구독을 구매하는 것은 구분해야 합니다.
- `CLOUD_PLAN_MODE=paid-included`, `INCLUDED_BUDGET_CONFIRMED=true`는 관리자가 현재 요금제·기존 사용량을 확인한 경우에만 설정합니다. 이 모드의 자체 예산은 하루 최대 30분·최근 32일 최대 2시간입니다. 달력 월 단위로도 2시간을 넘지 않습니다. Cloudflare의 청구 주기가 매월 1일과 같다고 가정하지 않으며, 이동 기간 제한을 별도로 적용합니다. 나머지 포함량은 여유로 남깁니다.
- 이 예산은 **이 프로그램의 사용량 제한**입니다. Cloudflare 계정 전체에 대한 공급자 과금 상한이 아니며, 계정의 다른 브라우저 프로그램이 소비하는 시간까지 자동 집계하지 않습니다. 다른 사용량이 있다면 포함량을 다시 확인해야 합니다. `ROLLING_32D_BROWSER_BUDGET_MS`, `MONTHLY_BROWSER_BUDGET_MS`의 상한은 각각 7,200,000ms입니다.
- 작업 전 전체 실행시간과 종료 여유분을 D1에서 원자적으로 예약합니다. 종료가 원격에서 확인된 경우만 실제 경과시간과 여유분으로 정산합니다. 종료 여부가 불명확하면 전체 예약분을 유지하고 새 실행을 보류합니다. 빈 작업 큐는 브라우저를 만들지 않으며 예약 예산을 전액 돌려놓습니다.
- 로그인 화면은 5분, 개별 작업은 최대 2분 동안 사용합니다. 종료를 위한 1분 여유분도 먼저 확보합니다. 예산이 부족하면 홈페이지 작업을 임대하기 전에 중단합니다.
- 날짜 경계를 넘겨 사용량을 잘못 계산하지 않도록, 전체 실행·종료 여유분이 UTC 사용량 집계 날짜를 넘는 시점에는 새 브라우저를 시작하지 않습니다. 임대가 만료되었지만 종료 여부가 확인되지 않은 전역 잠금은 재사용하지 않습니다.

공식 근거: [Browser Run 요금](https://developers.cloudflare.com/browser-run/pricing/), [한도와 무료 초과 처리](https://developers.cloudflare.com/browser-run/faq/), [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/).

## 운영자 배포 순서

1. 올바른 Cloudflare 계정과 현재 요금제·Browser Run 월 사용량을 확인합니다. 비용이 추가되는 업그레이드는 사용자에게 먼저 알립니다.
2. 전용 D1 저장소를 생성하고 `wrangler.toml`의 `STATE_DB` 실제 ID를 연결합니다. `schema.sql`을 실행하거나 첫 제어 요청 시 자동 초기화합니다.
3. `CLOUD_ADMIN_TOKEN`, 홈페이지와 동일한 `SPACECLOUD_WORKER_TOKEN`, 무작위 32자 이상의 `SESSION_ENCRYPTION_KEY`를 Secret으로 설정합니다. 채팅·쿼리 문자열·공개 JS에 넣지 않습니다.
4. 최초 배포에서는 `ENABLED=false`, `ALLOW_WRITES=false`를 유지합니다. 확인한 비용 모드만 설정합니다.
5. `crons=["* * * * *"]`와 `LOGIN_CLEANUP_SCHEDULED=true`를 함께 설정합니다. 로그인 전부터 이 정리 스케줄이 실행되어야 합니다. 작업 비활성 중에도 만료된 자체 브라우저를 종료합니다.
6. 전용 클라우드 브라우저 로그인과 읽기 전용 확인을 완료합니다. 빈 시간대의 등록·해제 종단 검증을 수행한 뒤에만 `ALLOW_WRITES=true`, `ENABLED=true`로 전환합니다.

```sh
npm ci
WRANGLER_LOG_PATH=/private/tmp/spacecloud-cloud.log npm run dry-run
npm test
```

`dry-run`은 배포하지 않습니다. 실제 리소스 생성·Secret 설정·배포는 소유자 계정과 비용을 확인한 운영자가 수행합니다. 기본 설정에는 활성 Cron이 없습니다.

## 사용자에게 필요한 로그인

운영자는 인증된 `POST /login/start`로 임시 로그인 화면을 만듭니다. 사용자는 전달받은 비공개 화면에서 **스페이스클라우드 호스트 계정으로 로그인**하고, 운영 화면의 **로그인 저장**을 누르면 됩니다. 비밀번호나 인증번호를 채팅에 보내거나 로컬 Chrome의 쿠키를 복사할 필요가 없습니다.

`POST /login/save`는 해당 클라우드 브라우저에 다시 연결하여 실제 소셜팩토리 호스트 캘린더를 확인한 뒤, **스페이스클라우드 도메인의** 쿠키·localStorage·IndexedDB 상태만 AES-GCM으로 암호화해 D1에 보관합니다. Google·네이버 등 로그인 제공자의 다른 도메인 상태는 보관하지 않습니다. 저장 후 원격 브라우저를 종료합니다. Live View 링크는 세션 접근 권한을 담고 있으므로 로그나 공개 페이지에 남기지 않습니다.

로그인이 만료되거나 Cloudflare 브라우저가 스페이스클라우드에서 차단되면 새 결제를 열지 않고 재로그인을 안내합니다. Cloudflare Browser Run 트래픽은 봇으로 식별되므로, 로그인과 저장 후 복원이 실제로 되는지 검증해야 합니다. [공식 Live View](https://developers.cloudflare.com/browser-run/features/live-view/), [Playwright 저장 상태](https://developers.cloudflare.com/browser-run/playwright/).

## 제어 API

공개 `GET /health`에는 서비스 이름과 활성 여부만 나옵니다. 다음 제어 요청은 `Authorization: Bearer CLOUD_ADMIN_TOKEN`이 필요합니다. 브라우저에서 직접 요청한다면 같은 원점만 허용합니다.

| 주소 | 동작 |
| --- | --- |
| `GET /status` | 로그인 저장 여부·자체 사용량·작업 잠금 상태 |
| `POST /login/start` | 5분짜리 전용 로그인 세션·Live View 생성 |
| `POST /login/save` `{login_id}` | 본인 세션의 호스트 로그인 확인·암호화 저장·종료 |
| `POST /login/cancel` `{login_id}` | 본인 임시 로그인 세션 종료 |
| `POST /check` | 저장한 로그인으로 1~5번룸 캘린더 읽기 전용 확인 |
| `POST /run` | 다음 예약 실행에서 처리한다는 `202` 응답만 반환 |
| `POST /maintenance` | 만료된 자체 브라우저 세션 정리 |

`/run`만 홈페이지 연결용 `SPACECLOUD_WORKER_TOKEN`도 허용합니다. 이 토큰으로 로그인 화면·저장 상태·관리 정보에 접근할 수는 없습니다. `/run` HTTP 요청 안에서는 예약을 임대하거나 UI를 조작하지 않습니다. 홈페이지의 요청이 끊겨도 작업이 중간에 종료되지 않도록 실제 쓰기는 Cloudflare Cron에서만 수행합니다.

Cron은 전용 로그인·비용 확인·예산·전역 잠금을 확인한 후 홈페이지 큐의 작업 하나를 임대합니다. 방별 충돌 잠금은 홈페이지 D1에 그대로 유지됩니다. 외부 UI 작업 중 20초마다 임대를 갱신하고, 등록·삭제 직전에도 권한과 시간을 확인합니다. 브라우저 종료를 확인하지 못하면 전역 잠금을 확인 필요 상태로 남깁니다. 기존 예약을 자동 삭제하거나 불명확한 작업을 다시 생성하지 않습니다.

평상시 외부 예약 유입은 기존 스페이스클라우드 iCal 수집을 사용합니다. 브라우저 유휴 수집 루프를 만들지 않아 비용을 줄입니다. 운영 전 1~5번룸의 비공개 iCal 연결이 설정되어 있는지 확인해야 합니다.
