import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1440,'height':900}); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(1200)
        await pg.fill('#seed','99'); await pg.click('text=平家（六波羅）'); await pg.wait_for_timeout(300)
        for i in range(400):
            await pg.click('#step1')
            if await pg.is_visible('#evmodal.on'):
                t = await pg.inner_text('#evTitle')
                if '源頼朝' in t and '挙兵' in t: break
                btns = await pg.query_selector_all('#evFoot button'); await btns[0].click()
        await pg.screenshot(path='/home/claude/work/ui_event.png')
        btns = await pg.query_selector_all('#evFoot button'); await btns[0].click()
        for i in range(12):
            await pg.click('#step1')
            while await pg.is_visible('#evmodal.on'):
                btns = await pg.query_selector_all('#evFoot button'); await btns[0].click()
        await pg.click('#zin'); await pg.wait_for_timeout(200)
        await pg.screenshot(path='/home/claude/work/ui_kanto.png')
        print('date', await pg.inner_text('#date'), 'errors', errs[:5])
        await b.close()
asyncio.run(main())
