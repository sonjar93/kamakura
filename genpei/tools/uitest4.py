import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1440,'height':900}); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(1000)
        await pg.click('text=平家（六波羅）'); await pg.wait_for_timeout(800)
        await pg.screenshot(path='/home/claude/work/v3_main.png')
        js = """([x,y])=>{const s=document.getElementById('map');const pt=s.createSVGPoint();pt.x=x;pt.y=y;const r=pt.matrixTransform(s.getScreenCTM());return [r.x,r.y];}"""
        for i in range(9):
            sx,sy = await pg.evaluate(js,[703,814]); await pg.mouse.move(sx,sy); await pg.mouse.wheel(0,-500); await pg.wait_for_timeout(120)
        await pg.wait_for_timeout(400); await pg.screenshot(path='/home/claude/work/v3_kyoto.png')
        await pg.set_viewport_size({'width':390,'height':844}); await pg.click('#zfit'); await pg.wait_for_timeout(400)
        await pg.screenshot(path='/home/claude/work/v3_mobile.png')
        print(errs[:5]); await b.close()
asyncio.run(main())
