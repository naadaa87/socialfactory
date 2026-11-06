#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v docker >/dev/null 2>&1 || { echo '상시 켜진 서버에 Docker와 Docker Compose가 필요합니다.' >&2; exit 1; }
docker compose version >/dev/null
task=${1:-prepare}
if [ ! -f .env ]; then
  (umask 077; cp .env.example .env)
  echo '.env를 만들었습니다. 실제 API_ORIGIN·비밀 토큰을 서버에서 설정한 뒤 다시 실행하세요.'
  exit 0
fi
chmod 600 .env
case "$task" in
  prepare)
    docker compose config --quiet
    docker compose build
    echo '서버 이미지 준비 완료. 로그인과 빈 시간 검증을 완료한 뒤 start를 실행하세요.'
    ;;
  login)
    : "${DISPLAY:?SSH X11 forwarding 또는 비공개 GUI 세션에서 실행하세요.}"
    : "${XAUTHORITY:?전용 서버 계정의 XAUTHORITY 파일 경로를 설정하세요.}"
    docker compose -f compose.yaml -f compose.login.yaml run --rm --no-deps spacecloud-worker
    ;;
  check)
    docker compose run --rm --no-deps spacecloud-worker node worker.mjs --check
    ;;
  start)
    docker compose run --rm --no-deps spacecloud-worker node --input-type=module -e 'import {readConfig} from "./queue.mjs"; if(!readConfig().allowWrites)throw new Error("빈 시간 검증 후 SPACECLOUD_ALLOW_WRITES=true 설정이 필요합니다.");'
    docker compose up -d
    ;;
  stop) docker compose stop ;;
  logs) docker compose logs -f --tail=50 ;;
  *) echo '사용법: sh deploy.sh prepare|login|check|start|stop|logs' >&2; exit 1 ;;
esac
