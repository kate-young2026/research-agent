"""Python 3.10+, reportlab, Pillow; Poppler for optional rendering."""
from pathlib import Path
import csv
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image, ImageDraw, ImageFont
import shutil
import subprocess
import os

root = Path(__file__).parent / 'generated' / '한글 경로'
root.mkdir(parents=True, exist_ok=True)
font = Path('C:/Windows/Fonts/malgun.ttf')
pdfmetrics.registerFont(TTFont('Korean', str(font)))
c = canvas.Canvas(str(root / '정상.pdf'))
c.setFont('Korean', 16)
c.drawString(60, 770, '파싱 검증용 문서')
c.setFont('Korean', 11)
c.drawString(60, 730, '학습자는 피드백을 읽고 자신의 글을 수정한다.')
c.drawString(60, 705, 'This is a synthetic PDF for parser testing.')
c.showPage()
c.setFont('Korean', 11)
c.drawString(60, 770, '두 번째 페이지의 학습 결과 기록입니다.')
c.save()
im = Image.new('RGB', (1200, 1600), 'white')
d = ImageDraw.Draw(im)
d.text((90, 140), '스캔 문서 파싱 시험', font=ImageFont.truetype(str(font), 48), fill='black')
d.text((90, 250), '학습자는 피드백을 읽습니다.', font=ImageFont.truetype(str(font), 36), fill='black')
im.save(root / '스캔.png')
c = canvas.Canvas(str(root / '스캔.pdf'), pagesize=(600, 800))
c.drawImage(str(root / '스캔.png'), 0, 0, 600, 800)
c.save()
(root / '손상.pdf').write_bytes(b'%PDF-1.7\ntruncated invalid PDF')
(root / '로그인.pdf').write_text('<html>Login required</html>', encoding='utf-8')
with (root / 'catalog.csv').open('w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['literature_id', 'pdf_status', 'file_path', 'title'])
    for row in [('T01', '확보 완료', '정상.pdf', '정상, "한글"'),
                ('T02', '확보 완료', '손상.pdf', '손상'),
                ('T03', '확보 완료', '없음.pdf', '누락'),
                ('T04', '확보 완료', '스캔.pdf', '스캔'),
                ('T05', '미확보', '정상.pdf', '미확보'),
                ('T06', '확보 완료', '로그인.pdf', 'HTML')]:
        w.writerow(row)
renderer = os.environ.get('PDFTOPPM') or shutil.which('pdftoppm')
if renderer:
    for name in ['정상', '스캔']:
        subprocess.run([renderer, '-scale-to', '1000', '-png', str(root / f'{name}.pdf'), str(root / name)], check=True)
print(root)
