import asyncio
from playwright.async_api import async_playwright
JS="""([x,y])=>{const s=document.getElementById('map');const pt=s.createSVGPoint();pt.x=x;pt.y=y;const r=pt.matrixTransform(s.getScreenCTM());return [r.x,r.y];}"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1440,'height':900}); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(1200)
        await pg.click('text=平家（六波羅）'); await pg.wait_for_timeout(700)
        await pg.screenshot(path='/home/claude/work/v5_overview.png')
        await pg.click('#toolbar button[data-act=muster]'); await pg.wait_for_timeout(300)
        await pg.screenshot(path='/home/claude/work/v5_org.png')
        await pg.click('#orgFoot >> text=出陣して行き先を選ぶ'); await pg.wait_for_timeout(300)
        # hover then click at Owari province hub
        hub = await pg.evaluate("()=>{return null}")
        x,y = await pg.evaluate(JS,[792,779])
        await pg.mouse.move(x,y); await pg.wait_for_timeout(200); await pg.mouse.move(x+3,y+3); await pg.wait_for_timeout(300)
        await pg.screenshot(path='/home/claude/work/v5_hover.png')
        await pg.mouse.click(x+3,y+3); await pg.wait_for_timeout(300)
        await pg.screenshot(path='/home/claude/work/v5_confirm.png')
        await pg.click('#pGo'); await pg.wait_for_timeout(300)
        print('toast', await pg.inner_text('#toast'))
        for i in range(6):
            await pg.click('#step1')
            while await pg.is_visible('#evmodal.on'):
                bs=await pg.query_selector_all('#evFoot button'); await bs[0].click()
        await pg.click('#ltabs button[data-t=armies]'); await pg.wait_for_timeout(200)
        await pg.screenshot(path='/home/claude/work/v5_march.png')
        print('errors', errs[:5]); await b.close()
asyncio.run(main())
