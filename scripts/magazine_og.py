#!/usr/bin/env python3
"""매거진 글의 공유 미리보기 이미지(images/og/<slug>.jpg, 1200×630)를 만듭니다.

카카오톡 · 페이스북 미리보기에서 webp 가 보이지 않는 경우가 있어, 대표 이미지(cover)를
가운데 기준으로 잘라 jpg 로 저장합니다. 이미 있는 파일은 건드리지 않습니다.

실행: python3 scripts/magazine_og.py          (없는 것만 만들기)
      python3 scripts/magazine_og.py --force  (전부 다시 만들기)
Pillow(PIL)가 없으면 아무것도 하지 않고 끝나며, 그때는 글 페이지가 대표 이미지를 그대로 씁니다.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = os.path.join(ROOT, 'content', 'magazine', 'posts')
OUT = os.path.join(ROOT, 'images', 'og')
W, H = 1200, 630

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print('Pillow 가 없어 미리보기 이미지를 건너뜁니다 (pip install pillow).')
    sys.exit(0)


def front_matter(path):
    text = open(path, encoding='utf-8').read()
    m = re.match(r'^---\r?\n(.*?)\r?\n---', text, re.S)
    meta = {}
    if m:
        for line in m.group(1).splitlines():
            if ':' in line:
                k, v = line.split(':', 1)
                meta[k.strip()] = v.strip().strip('"')
    return meta


def main():
    force = '--force' in sys.argv
    os.makedirs(OUT, exist_ok=True)
    made = 0
    for name in sorted(os.listdir(POSTS)):
        if not name.endswith('.md'):
            continue
        meta = front_matter(os.path.join(POSTS, name))
        slug, cover = meta.get('slug'), meta.get('cover', '').lstrip('/')
        if not slug or not cover:
            continue
        dest = os.path.join(OUT, slug + '.jpg')
        src = os.path.join(ROOT, cover)
        if (os.path.exists(dest) and not force) or not os.path.exists(src):
            continue
        im = Image.open(src).convert('RGB')
        scale = max(W / im.width, H / im.height)
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
        left, top = (im.width - W) // 2, (im.height - H) // 2
        im.crop((left, top, left + W, top + H)).save(dest, 'JPEG', quality=82, optimize=True, progressive=True)
        made += 1
        print('만듦', os.path.relpath(dest, ROOT))
    print(f'미리보기 이미지 {made}개')


if __name__ == '__main__':
    main()
