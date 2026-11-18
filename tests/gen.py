from PIL import Image, ImageDraw, ImageFont
F='/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc'
def seg(d, y0, W, Hs, label):
    # panels
    d.rectangle([20,y0+20,W-20,y0+Hs-20], outline=(40,40,40), width=6, fill=(205,210,215))
    d.rectangle([60,y0+int(Hs*0.32),W-60,y0+int(Hs*0.55)], fill=(150,170,190))
    # bubble A: normalized box [80,100,240,520]
    ax0,ay0,ax1,ay1 = int(.10*W), y0+int(.08*Hs), int(.52*W), y0+int(.24*Hs)
    d.ellipse([ax0-30,ay0-30,ax1+30,ay1+30], fill='white', outline='black', width=5)
    f=ImageFont.truetype(F,44)
    d.multiline_text(((ax0+ax1)//2,(ay0+ay1)//2), "안녕하세요!\n오늘 어때요?", font=f, fill='black', anchor='mm', align='center')
    # bubble B (dark): [600,480,760,920]
    bx0,by0,bx1,by1 = int(.48*W), y0+int(.60*Hs), int(.92*W), y0+int(.76*Hs)
    d.rectangle([bx0-10,by0-10,bx1+10,by1+10], fill=(15,15,20))
    d.text(((bx0+bx1)//2,(by0+by1)//2), "가자! "+label, font=ImageFont.truetype(F,56), fill='white', anchor='mm')
def page(name, W, H, n, tag):
    im=Image.new('RGB',(W,H),(235,235,235)); d=ImageDraw.Draw(im)
    for i in range(n): seg(d, i*H//n, W, H//n, f"{tag}{i+1}")
    im.save(name)
page('img/page1.png',800,1200,1,'A'); page('img/page2.png',800,1200,1,'B'); page('img/page3.png',800,1200,1,'C')
page('img/strip.png',800,5000,4,'S'); page('site/local.png',800,1200,1,'L')
Image.new('RGB',(120,120),(200,50,50)).save('img/small.png')
