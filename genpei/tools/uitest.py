import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1440,'height':900})
        errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append('console:'+m.text) if m.type=='error' else None)
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/home/claude/work/ui_start.png')
        await pg.click('text=源頼朝（伊豆・北条）'); await pg.wait_for_timeout(500)
        await pg.screenshot(path='/home/claude/work/ui_main.png')
        # advance month a few times resolving modals
        for i in range(8):
            await pg.click('#stepM'); await pg.wait_for_timeout(200)
            for j in range(6):
                if await pg.is_visible('#evmodal.on'):
                    btns = await pg.query_selector_all('#evFoot button')
                    await btns[0].click(); await pg.wait_for_timeout(100)
        await pg.screenshot(path='/home/claude/work/ui_later.png')
        await pg.fill('#nl','挙兵する'); await pg.press('#nl','Enter'); await pg.wait_for_timeout(300)
        for j in range(4):
            if await pg.is_visible('#evmodal.on'):
                btns = await pg.query_selector_all('#evFoot button'); await btns[0].click(); await pg.wait_for_timeout(100)
        await pg.click('#rtabs button[data-t=ai]'); await pg.click('#ltabs button[data-t=military]')
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='/home/claude/work/ui_mil.png')
        await pg.set_viewport_size({'width':390,'height':844}); await pg.wait_for_timeout(300)
        await pg.screenshot(path='/home/claude/work/ui_mobile.png')
        print('date', await pg.inner_text('#date'))
        print('cmdlog', (await pg.inner_text('#cmdlog'))[:400])
        print('errors', errs[:10])
        await b.close()
asyncio.run(main())
