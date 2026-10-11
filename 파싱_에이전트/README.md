# kordoc 파싱 에이전트

두 번째 에이전트의 PDF 수집 결과를 사용자가 확인하고 파싱에 동의하면, Luna / High 담당자가 승인된 PDF를 처리합니다. 실제 변환 엔진은 [kordoc](https://github.com/chrisryugj/kordoc)이며 모델 API 키는 필요하지 않습니다. 코드가 Luna를 호출하는 것은 아니며 에이전트의 실행 모델은 AGENTS.md의 위임 절차로 지정합니다.

## 설치

Node.js 20 이상과 pnpm을 사용합니다. 이 폴더에서 다음을 실행합니다.

```powershell
pnpm install --frozen-lockfile
node parse_pdfs.mjs --help
```

`package.json`은 kordoc 4.21.22와 csv-parse 6.1.0을 고정하며 `pnpm-lock.yaml`은 하위 의존성을 고정합니다. `pnpm-workspace.yaml`은 OCR용 onnxruntime-node와 protobufjs 빌드를 허용합니다. PowerShell에서 명령이 차단되면 `pnpm.cmd`를 사용합니다. 전역 MCP 설정 변경은 필요하지 않습니다.

Codex 번들 런타임을 쓰는 환경에서는 `load_workspace_dependencies`가 반환한 Node 실행 파일과 pnpm 경로를 사용합니다. 이 컴퓨터의 번들 Node는 PATH에 없을 수 있으므로 전체 경로로 실행합니다.

## 승인 및 실행

아래 경로·ID는 예시입니다. 실제 실행 전 수집 결과를 보고 **“확보한 PDF를 kordoc으로 파싱할까요?”**라고 물어 승인받습니다.

```powershell
node parse_pdfs.mjs --catalog "../연구계획서/문헌수집/literature_catalog.csv" --dry-run
node parse_pdfs.mjs --catalog "../연구계획서/문헌수집/literature_catalog.csv" --ids "AD01,AD06" --approval-note "사용자가 해당 수집 결과의 AD01, AD06 파싱을 승인한 대화 근거"
```

- `--catalog`: 필수 CSV 경로. UTF-8/BOM, 따옴표·쉼표·줄바꿈 필드를 지원합니다.
- `--ids`: 쉼표 구분 승인 ID. 실제 실행에는 필수입니다. 목록에 없는 ID·중복 ID·누락 열은 작업 전 오류로 처리합니다.
- `--output`: 선택 출력 폴더. 기본값은 CSV 폴더 아래 `파싱`입니다.
- `--dry-run`: CSV와 파일 존재만 검사합니다. PDF 읽기·kordoc 로딩·결과 저장은 하지 않습니다.
- `--approval-note`: 실제 실행에 필요한 승인 근거 기록. 인수를 채우는 것만으로 사용자 승인이 생기지 않습니다.

확보 완료가 아닌 문헌은 건너뜁니다. 종료 코드는 전체 처리 중 실패 없음 0, 파일별 실패 있음 1, 입력·환경 오류 2입니다. `검토 필요`는 보고서에서 별도로 확인합니다.

## OCR 모델 준비

실제 일괄 파싱은 항상 오프라인입니다. 기본 모델 캐시는 이 폴더의 `.cache/models`이며 `KORDOC_MODEL_CACHE`로 별도 로컬 캐시를 지정할 수 있습니다. 모델이 없을 때 내용을 추측하거나 외부 OCR을 사용하지 않고 경고·실패를 보고합니다.

인터넷을 사용할 수 있는 설치 단계에서 **합성 스캔 PDF**로 모델만 준비할 수 있습니다. 다음 명령의 온라인 접근은 OCR 모델 다운로드용이며 문서 OCR은 로컬에서 수행됩니다.

```powershell
$env:KORDOC_MODEL_CACHE = Join-Path $PWD '.cache/models'
$env:KORDOC_OFFLINE = '0'
node node_modules/kordoc/dist/cli.js "tests/generated/한글 경로/스캔.pdf" --ocr -o "tests/generated/ocr_setup.md"
node node_modules/kordoc/dist/cli.js models --status
$env:KORDOC_OFFLINE = '1'
```

합성 파일은 먼저 `python tests/create_fixtures.py`로 만듭니다(Python 3.10+, reportlab, Pillow, Windows 맑은 고딕). 폐쇄망은 공식 `kordoc models --export <폴더>` / `--import <폴더>`를 사용합니다. 설치와 OCR 실행 오류를 구분합니다. [공식 사용법](https://github.com/chrisryugj/kordoc/blob/main/docs/usage.md)

## 출력과 재실행

```text
문헌수집/파싱/
  documents/<문헌ID-식별해시>/<실행ID>/document.md
  documents/<문헌ID-식별해시>/<실행ID>/document.json
  runs/<실행ID>/manifest.json
  runs/<실행ID>/parsing_catalog.csv
  runs/<실행ID>/verification_report.md
```

JSON은 원본 해시·절대 경로·목록 해시·kordoc 버전·옵션·페이지·구조화 블록·자동 검증 결과를 담습니다. 이미지 바이너리는 저장하지 않습니다. 페이지 번호는 PDF 내부 순서이며 인쇄 쪽수가 아닙니다. CSV는 UTF-8 BOM입니다. 실행 폴더는 UTC 시각과 임의 식별자로 구분합니다.

자동 점검은 빈 본문, 대체 문자, 페이지 공백·불연속·개수, 표와 경고를 확인합니다. 자동 점검을 통과해도 OCR 오인식·표·다단 읽기 순서는 원문 대조가 필요합니다. 에이전트의 실제 시각 점검은 별도 `visual_review.md`로 기록합니다. 동일 원본·버전·옵션의 완료 결과만 재사용하며 수작업으로 수정된 Markdown은 재사용하지 않습니다. 기존 결과는 덮어쓰지 않습니다.

## 개발 검증

```powershell
python tests/create_fixtures.py
node --test tests/parser.test.mjs
```

`PDFTOPPM` 환경변수에 Poppler 실행 파일 경로를 지정하면 합성 PDF의 확인용 PNG도 생성합니다. 시험 결과는 `TEST_RESULTS.md`에 기록합니다. 실제 논문은 별도 승인 전 테스트 대상으로 사용하지 않습니다.
