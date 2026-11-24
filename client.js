/**
 * Client half of the restart button.
 *
 * Occupies `sidebar.footer.action`: a 42px row above Settings at the sidebar
 * foot, following the platform's own badge metric (42px row, 12px radius, the
 * 8px rhythm of the header controls). The first press turns the row into an
 * in-place two-choice confirm, so the guard costs no extra dialog and no extra
 * surface: "Restart" sends the request, "Cancel" (or Escape, or a press on the
 * row itself) returns to idle.
 *
 * Work guard: before the confirm opens, the row asks the Host route how many
 * agent turns are live through the standard `useSessions` root hook (each
 * Session row carries the Host-authoritative `running` flag). When any Session
 * is running the row refuses and says so, and the Host re-checks the same fact
 * and answers 409 instead of restarting.
 *
 * Everything is drawn here: the Harness UI primitives package is bundled into
 * the web frontend and is not part of the client module table this bundle can
 * require, so the row cannot borrow its Button or Tooltip. The refresh glyph is
 * the platform's own 16px outline path, inlined.
 */

window.__ModuleLoader__.load({
  id: '@dsh-local/restart-button',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Route the Host registers; keep in sync with index.js. */
    const ROUTE = '/dsh-local/restart-button/request'

    const COPY = {
      en: {
        idle: 'Restart',
        confirm: 'Restart now?',
        yes: 'Restart',
        no: 'Cancel',
        aria: 'Restart DeepSeek Harness',
        busy: 'A turn is running. Stop it first.',
        intent: 'Restarting…',
        failed: 'Could not reach the Host.',
      },
      zh: {
        idle: '重启',
        confirm: '现在重启？',
        yes: '重启',
        no: '取消',
        aria: '重启 DeepSeek Harness',
        busy: '有对话正在运行，请先停止。',
        intent: '正在重启…',
        failed: '没能连到 Host。',
      },
    }

    function pickLocale() {
      const tags = Array.isArray(navigator.languages) ? [...navigator.languages] : []
      if (typeof navigator.language === 'string') tags.push(navigator.language)
      for (const tag of tags) {
        const primary = String(tag).toLowerCase().split('-')[0]
        if (primary === 'zh') return COPY.zh
        if (primary === 'en') return COPY.en
      }
      return COPY.en
    }

    const CSS = [
      '.rb-layer { flex: none; display: flex; align-items: center; width: 100%; margin: 8px 0 0; }',
      '.rb-row { display: flex; align-items: center; gap: 8px; width: calc(100% + 4px); height: 42px;',
      '  margin: 0 -2px; padding: 0 8px; border: none; border-radius: 12px; background: transparent;',
      '  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; text-align: left;',
      '  cursor: pointer; overflow: hidden; }',
      '@media (hover: hover) { .rb-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }',
      '.rb-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }',
      '.rb-glyph { flex: none; display: inline-flex; align-items: center; justify-content: center; }',
      '.rb-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.rb-muted { color: var(--dsw-alias-label-secondary); font-size: 13px; }',
      '.rb-split { flex: 1 1 auto; display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }',
      '.rb-choice { flex: none; height: 28px; padding: 0 10px; border: none; border-radius: 8px;',
      '  font: inherit; font-size: 13px; cursor: pointer;',
      '  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.rb-choice[data-primary] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-brand-primary-invert); }',
      '.rb-choice[data-primary]:hover { background: var(--dsw-alias-button-primary-hover); }',
      '.rb-layer.rb-rail { width: 36px; height: 36px; margin: 0; }',
      '.rb-rail .rb-row { justify-content: center; width: 36px; height: 36px; padding: 0; border-radius: 50%; }',
      '.rb-rail .rb-text, .rb-rail .rb-split { display: none; }',
    ].join('\n')

    function RefreshGlyph() {
      return h(
        'span',
        { className: 'rb-glyph' },
        h(
          'svg',
          {
            xmlns: 'http://www.w3.org/2000/svg',
            viewBox: '0 0 16 16',
            width: '16',
            height: '16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: '1.2',
            'aria-hidden': 'true',
          },
          h('path', {
            d: 'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
          }),
          h('path', { d: 'M14.4999 1.5V5.1H10.8999' }),
        ),
      )
    }

    /**
     * The sidebar-foot row.
     * @param props - slot props; `wide` is the sidebar column state, so false
     * draws the rail circle that shows only the glyph. The standard root hooks
     * arrive as `useSessions` (Host list snapshots) when the slot provides them.
     */
    function RestartRow(props) {
      const text = React.useMemo(pickLocale, [])
      const [phase, setPhase] = React.useState('idle')
      const timer = React.useRef(undefined)
      const useSessions = props.useSessions
      const runningCount = useSessions === undefined
        ? 0
        : useSessions((state) => {
            let count = 0
            for (const id of state.ids) {
              const row = state.byId[id]
              if (row !== undefined && row.running) count += 1
            }
            return count
          })

      React.useEffect(
        () => () => {
          if (timer.current !== undefined) clearTimeout(timer.current)
        },
        [],
      )

      const settle = React.useCallback((next, ttl) => {
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = undefined
        setPhase(next)
        if (ttl > 0) timer.current = setTimeout(() => setPhase('idle'), ttl)
      }, [])

      const send = React.useCallback(
        async (event) => {
          event.stopPropagation()
          event.preventDefault()
          setPhase('sending')
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
            if (response.status === 409) {
              settle('busy', 5000)
              return
            }
            settle(response.ok ? 'intent' : 'failed', response.ok ? 15000 : 4000)
          } catch {
            settle('failed', 4000)
          }
        },
        [settle],
      )

      const openConfirm = React.useCallback(
        (event) => {
          event.stopPropagation()
          event.preventDefault()
          if (runningCount > 0) {
            settle('busy', 5000)
            return
          }
          settle('confirm', 0)
        },
        [runningCount, settle],
      )

      const cancel = React.useCallback(
        (event) => {
          event.stopPropagation()
          event.preventDefault()
          settle('idle', 0)
        },
        [settle],
      )

      const onKeyDown = React.useCallback(
        (event) => {
          if (event.key !== 'Escape') return
          if (phase === 'idle') return
          event.preventDefault()
          cancel(event)
        },
        [cancel, phase],
      )

      const onRowClick =
        phase === 'idle' ? openConfirm : phase === 'confirm' ? cancel : undefined

      const label =
        phase === 'idle'
          ? text.idle
          : phase === 'confirm'
            ? text.confirm
            : phase === 'sending'
              ? '…'
              : phase === 'busy'
                ? text.busy
                : phase === 'intent'
                  ? text.intent
                  : text.failed

      const body =
        phase === 'confirm'
          ? [
              h('span', { key: 'text', className: 'rb-text' }, text.confirm),
              h(
                'span',
                { key: 'split', className: 'rb-split' },
                h('button', { key: 'no', type: 'button', className: 'rb-choice', onClick: cancel }, text.no),
                h(
                  'button',
                  { key: 'yes', type: 'button', className: 'rb-choice', 'data-primary': 'true', onClick: send },
                  text.yes,
                ),
              ),
            ]
          : [
              h('span', { key: 'glyph' }, h(RefreshGlyph)),
              h(
                'span',
                {
                  key: 'text',
                  className: `rb-text${phase === 'idle' ? '' : ' rb-muted'}`,
                  title: phase === 'idle' ? undefined : label,
                },
                label,
              ),
            ]

      return h(
        'div',
        { className: `rb-layer${props.wide ? '' : ' rb-rail'}` },
        h(
          'button',
          {
            type: 'button',
            className: 'rb-row',
            'aria-label': phase === 'idle' ? text.aria : label,
            'aria-haspopup': phase === 'idle' ? 'dialog' : undefined,
            onClick: onRowClick,
            onKeyDown,
          },
          body,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        /**
         * Runtime style element. It is created by the effects below, not here,
         * so the module factory itself stays side-effect free.
         */
        function mountStyle() {
          const style = document.createElement('style')
          style.dataset.plugin = '@dsh-local/restart-button'
          style.textContent = CSS
          document.head.appendChild(style)
        }

        ctx.effect(() => {
          mountStyle()
          return () => {
            const mounted = document.querySelector('style[data-plugin="@dsh-local/restart-button"]')
            if (mounted !== null) mounted.remove()
          }
        }, 'restart-button: styles')

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'restart-button',
              order: 10,
            },
            RestartRow,
          ),
        )
      },
    }
  },
})
