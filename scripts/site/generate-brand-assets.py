#!/usr/bin/env python3
"""Generate deterministic Gemmaclaw lobster + diamond brand assets."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
REPO=Path(__file__).resolve().parents[2]; ASSET_DIR=REPO/'site'/'assets'; ASSET_DIR.mkdir(parents=True,exist_ok=True)
RED='#ff4f40'; RED_DARK='#b4232a'; INK='#172033'; BLUE='#4285f4'; BLUE_SOFT='#dbe8fc'; WHITE='#ffffff'; BG='#f6f8fa'
LOGO_SVG=f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">Gemmaclaw lobster diamond logo</title><desc id="desc">A minimalist red lobster centered inside a blue diamond.</desc>
  <rect width="512" height="512" rx="96" fill="{WHITE}"/>
  <path d="M256 54 458 256 256 458 54 256Z" fill="{BLUE_SOFT}" stroke="{BLUE}" stroke-width="24" stroke-linejoin="round"/>
  <path d="M256 100 412 256 256 412 100 256Z" fill="{WHITE}" opacity="0.72"/>
  <g fill="none" stroke="{RED_DARK}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"><path d="M158 236c-46-8-76-30-86-64 34-12 72-2 96 25"/><path d="M354 236c46-8 76-30 86-64-34-12-72-2-96 25"/><path d="M176 252c-40 14-72 43-91 79"/><path d="M336 252c40 14 72 43 91 79"/><path d="M182 316c-30 9-55 27-74 54"/><path d="M330 316c30 9 55 27 74 54"/></g>
  <path d="M256 142c-62 0-104 45-104 111 0 79 56 126 104 155 48-29 104-76 104-155 0-66-42-111-104-111Z" fill="{RED}" stroke="{RED_DARK}" stroke-width="18" stroke-linejoin="round"/>
  <path d="M196 242h120" stroke="{RED_DARK}" stroke-width="14" stroke-linecap="round" opacity="0.45"/><path d="M199 291h114" stroke="{RED_DARK}" stroke-width="14" stroke-linecap="round" opacity="0.35"/><path d="M216 344h80" stroke="{RED_DARK}" stroke-width="14" stroke-linecap="round" opacity="0.28"/>
  <g fill="{INK}"><circle cx="224" cy="199" r="10"/><circle cx="288" cy="199" r="10"/></g><g fill="none" stroke="{INK}" stroke-width="12" stroke-linecap="round"><path d="M228 174 205 142"/><path d="M284 174 307 142"/></g>
</svg>\n'''
def font(size,bold=False):
    for p in (["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"] if bold else ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf","/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"]):
        if Path(p).exists(): return ImageFont.truetype(p,size)
    return ImageFont.load_default()
def draw_mark(d,box):
    x0,y0,x1,y1=box; w=x1-x0; h=y1-y0; cx=x0+w/2
    def pt(x,y): return (x0+x*w,y0+y*h)
    d.polygon([pt(.5,.05),pt(.95,.5),pt(.5,.95),pt(.05,.5)], fill=BLUE_SOFT, outline=BLUE)
    d.line([pt(.5,.05),pt(.95,.5),pt(.5,.95),pt(.05,.5),pt(.5,.05)], fill=BLUE, width=max(6,int(w*.055)))
    d.polygon([pt(.5,.14),pt(.86,.5),pt(.5,.86),pt(.14,.5)], fill=WHITE)
    lw=max(4,int(w*.04))
    for pts in [[(.35,.45),(.18,.40),(.10,.28)],[(.18,.40),(.07,.34)],[(.65,.45),(.82,.40),(.90,.28)],[(.82,.40),(.93,.34)],[(.35,.55),(.16,.68)],[(.65,.55),(.84,.68)],[(.38,.68),(.22,.82)],[(.62,.68),(.78,.82)]]: d.line([pt(*q) for q in pts], fill=RED_DARK, width=lw, joint='curve')
    body=[pt(.5,.25),pt(.70,.34),pt(.73,.55),pt(.66,.72),pt(.5,.88),pt(.34,.72),pt(.27,.55),pt(.30,.34)]
    d.polygon(body, fill=RED, outline=RED_DARK); d.line([pt(.38,.48),pt(.62,.48)], fill=RED_DARK, width=max(3,int(lw*.75))); d.line([pt(.39,.60),pt(.61,.60)], fill=RED_DARK, width=max(3,int(lw*.65))); d.line([pt(.43,.72),pt(.57,.72)], fill=RED_DARK, width=max(3,int(lw*.55)))
    er=max(2,int(w*.022)); d.line([pt(.45,.33),pt(.39,.23)], fill=INK, width=max(2,int(lw*.5))); d.line([pt(.55,.33),pt(.61,.23)], fill=INK, width=max(2,int(lw*.5)))
    d.ellipse([cx-w*.075-er,y0+h*.36-er,cx-w*.075+er,y0+h*.36+er], fill=INK); d.ellipse([cx+w*.075-er,y0+h*.36-er,cx+w*.075+er,y0+h*.36+er], fill=INK)
def mark_png(size,path):
    sc=4; img=Image.new('RGBA',(size*sc,size*sc),(255,255,255,255)); d=ImageDraw.Draw(img); d.rounded_rectangle([0,0,size*sc-1,size*sc-1], radius=int(size*sc*.18), fill=WHITE); pad=int(size*sc*.06); draw_mark(d,(pad,pad,size*sc-pad,size*sc-pad)); img.resize((size,size),Image.Resampling.LANCZOS).save(path)
def social(path):
    img=Image.new('RGB',(1200,630),BG); d=ImageDraw.Draw(img); d.polygon([(1030,80),(1160,210),(1030,340),(900,210)],fill='#e8f0fe'); d.polygon([(120,390),(250,520),(120,650),(-10,520)],fill='#ffe8e5'); d.rounded_rectangle([56,56,1144,574], radius=44, fill=WHITE, outline='#d0d7de', width=2); draw_mark(d,(96,135,456,495)); d.text((510,180),'Gemmaclaw',font=font(86,True),fill=INK); d.text((516,292),'Gemma setup, tuned for your hardware',font=font(38),fill='#424a53'); d.text((516,370),'Minimal lobster + diamond mark',font=font(26),fill=BLUE); img.save(path,quality=95)
def main():
    (ASSET_DIR/'gemmaclaw-logo.svg').write_text(LOGO_SVG); (ASSET_DIR/'favicon.svg').write_text(LOGO_SVG.replace('width="512" height="512"','width="64" height="64"'))
    for size,name in [(16,'favicon-16x16.png'),(32,'favicon-32x32.png'),(180,'apple-touch-icon.png'),(512,'gemmaclaw-logo.png'),(1024,'gemmaclaw-org-logo.png')]: mark_png(size,ASSET_DIR/name)
    social(ASSET_DIR/'gemmaclaw-github-social.png'); print(f'Generated brand assets in {ASSET_DIR}')
if __name__=='__main__': main()
