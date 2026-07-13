import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook, cleanup } from '@testing-library/react'
import { useOAuthPopup } from '../src/useOAuthPopup'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// A minimal stand-in for the popup Window the hook only ever reads `.closed` from.
const makePopup = () => ({ closed: false }) as unknown as Window & { closed: boolean }

// Post a message as the popup would. Default origin = our own origin (the popup is
// first-party), so it matches the hook's default allowedOrigin regardless of the
// jsdom base URL.
const post = (data: unknown, origin: string = window.location.origin) =>
  window.dispatchEvent(new MessageEvent('message', { data, origin }))

describe('useOAuthPopup — opening the popup', () => {
  it('opens window.open with the auth url and the default name/features and goes pending', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const { result } = renderHook(() => useOAuthPopup('/auth/google'))
    act(() => result.current.signIn())
    expect(openSpy).toHaveBeenCalledWith('/auth/google', 'oauth-login', 'width=460,height=600')
    expect(result.current.pending).toBe(true)
  })

  it('honours a custom windowName + features', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const { result } = renderHook(() => useOAuthPopup('/x', { windowName: 'w', features: 'f' }))
    act(() => result.current.signIn())
    expect(openSpy).toHaveBeenCalledWith('/x', 'w', 'f')
  })

  it('calls onCancel and stays not-pending when the popup is blocked (window.open → null)', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const onCancel = vi.fn()
    const { result } = renderHook(() => useOAuthPopup('/x', { onCancel }))
    act(() => result.current.signIn())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })
})

describe('useOAuthPopup — receiving the token', () => {
  it('resolves the token from an origin-matched postMessage, calls onToken and clears pending', () => {
    vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const onToken = vi.fn()
    const { result } = renderHook(() => useOAuthPopup('/x', { onToken }))
    act(() => result.current.signIn())
    act(() => void post({ type: 'oauth', token: 'TOK' }))
    expect(onToken).toHaveBeenCalledWith('TOK')
    expect(result.current.token).toBe('TOK')
    expect(result.current.pending).toBe(false)
  })

  it('ignores a message from a different origin', () => {
    vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const onToken = vi.fn()
    const { result } = renderHook(() => useOAuthPopup('/x', { onToken }))
    act(() => result.current.signIn())
    act(() => void post({ type: 'oauth', token: 'TOK' }, 'https://evil.example'))
    expect(onToken).not.toHaveBeenCalled()
    expect(result.current.token).toBeNull()
    expect(result.current.pending).toBe(true) // still waiting
  })

  it('ignores a wrong message type or a missing token', () => {
    vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const onToken = vi.fn()
    const { result } = renderHook(() => useOAuthPopup('/x', { onToken }))
    act(() => result.current.signIn())
    act(() => void post({ type: 'some-other-type', token: 'TOK' }))
    act(() => void post({ type: 'oauth' })) // no token
    expect(onToken).not.toHaveBeenCalled()
  })

  it('honours a custom messageType + allowedOrigin', () => {
    vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const onToken = vi.fn()
    const { result } = renderHook(() =>
      useOAuthPopup('/x', { messageType: 'my-type', allowedOrigin: 'https://a.example', onToken }),
    )
    act(() => result.current.signIn())
    // default-origin message is now rejected...
    act(() => void post({ type: 'my-type', token: 'nope' }))
    expect(onToken).not.toHaveBeenCalled()
    // ...only the configured origin + type is accepted
    act(() => void post({ type: 'my-type', token: 'T2' }, 'https://a.example'))
    expect(onToken).toHaveBeenCalledWith('T2')
  })
})

describe('useOAuthPopup — cancellation + teardown', () => {
  it('polls for a closed popup and calls onCancel', () => {
    vi.useFakeTimers()
    const popup = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const onCancel = vi.fn()
    const { result } = renderHook(() => useOAuthPopup('/x', { onCancel }))
    act(() => result.current.signIn())
    expect(result.current.pending).toBe(true)
    popup.closed = true
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })

  it('removes the message listener on unmount (a late message is ignored)', () => {
    vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const onToken = vi.fn()
    const { result, unmount } = renderHook(() => useOAuthPopup('/x', { onToken }))
    act(() => result.current.signIn())
    unmount()
    act(() => void post({ type: 'oauth', token: 'TOK' }))
    expect(onToken).not.toHaveBeenCalled()
  })

  it('abandons a prior attempt when signIn is called again (only one active listener)', () => {
    vi.spyOn(window, 'open').mockReturnValue(makePopup())
    const onToken = vi.fn()
    const { result } = renderHook(() => useOAuthPopup('/x', { onToken }))
    act(() => result.current.signIn())
    act(() => result.current.signIn())
    act(() => void post({ type: 'oauth', token: 'TOK' }))
    expect(onToken).toHaveBeenCalledTimes(1)
  })
})
