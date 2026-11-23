import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1440,'height':900}); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(1200)
        await pg.screenshot(path='/home/claude/work/v2_start.png')
        await pg.click('text=源頼朝（伊豆・北条）'); await pg.wait_for_timeout(800)
        await pg.screenshot(path='/home/claude/work/v2_main.png')
        # build: open tab, pick point in Izu (hojo area)
        await pg.click('#cmdbar button[data-go=build]'); await pg.wait_for_timeout(200)
        await pg.select_option('#bdS','small'); await pg.fill('#bdN','北条の新館')
        await pg.click('#bBuild')
        # convert map coords to screen
        js = """([x,y])=>{const s=document.getElementById('map');const pt=s.createSVGPoint();pt.x=x;pt.y=y;const m=s.getScreenCTM();const r=pt.matrixTransform(m);return [r.x,r.y];}"""
        sx,sy = await pg.evaluate(js,[1000,840])
        await pg.mouse.click(sx,sy); await pg.wait_for_timeout(300)
        print('cmd', (await pg.inner_text('#cmdlog'))[:300])
        for i in range(140):
            await pg.click('#step1')
            while await pg.is_visible('#evmodal.on'):
                t=await pg.inner_text('#evTitle')
                btns = await pg.query_selector_all('#evFoot button'); await btns[0].click()
        # zoom into Kanto
        await pg.evaluate("""()=>{}""")
        for i in range(3):
            sx,sy = await pg.evaluate(js,[1010,780]); await pg.mouse.move(sx,sy); await pg.mouse.wheel(0,-600); await pg.wait_for_timeout(150)
        await pg.wait_for_timeout(400)
        await pg.screenshot(path='/home/claude/work/v2_zoom.png')
        print('date', await pg.inner_text('#date'), 'errors', errs[:5])
        await b.close()
asyncio.run(main())
