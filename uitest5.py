import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1440,'height':900}); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(1000)
        await pg.click('text=平家（六波羅）'); await pg.wait_for_timeout(600)
        await pg.evaluate("()=>{}")
        js = """([x,y])=>{const s=document.getElementById('map');const pt=s.createSVGPoint();pt.x=x;pt.y=y;const r=pt.matrixTransform(s.getScreenCTM());return [r.x,r.y];}"""
        for i in range(14):
            sx,sy = await pg.evaluate(js,[704,815]); await pg.mouse.move(sx,sy); await pg.mouse.wheel(0,-500); await pg.wait_for_timeout(100)
        await pg.wait_for_timeout(400); await pg.screenshot(path='/home/claude/work/v4_kyoto.png')
        print(errs[:3]); await b.close()
asyncio.run(main())
