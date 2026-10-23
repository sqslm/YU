/**
 * Sign-in / sign-up form, shared by the settings account section and the
 * first-run tour.
 *
 * One component because the two places must not drift: the tour teaches the
 * form, the settings section is where people come back to it months later.
 * Everything that differs between them is layout (`dense`), never behaviour —
 * a validation rule that exists only in onboarding would let a tour-passed
 * account fail the first real sign-in.
 *
 * The server address is shown on an unconfigured install and folded away once
 * configured. No personal deployment is chosen for an open-source install.
 */
import { useEffect, useState } from 'react'
import { Box, Button, CircularProgress, TextField, Typography } from '@mui/material'
import type { AccountView, ServerMeta } from '@shared/types'
import { normalizeServerUrl } from '@shared/defaults'
import { Segmented } from './sections/General'
import i18n from '../i18n'

export type AccountMode = 'login' | 'register' | 'reset'

export interface AccountFormProps {
  /** Server address from settings; shown folded under "高级". */
  server: string
  /** Fired after a successful sign-in or sign-up. */
  onSignedIn: (view: AccountView | null) => void
  /** Fired when the address the user typed differs from what settings holds. */
  onServerChange?: (server: string) => void
  /** Tour variant: no outer card padding, tighter vertical rhythm. */
  dense?: boolean
  /** Where the tour starts; the settings section always starts at "login". */
  initialMode?: AccountMode
}

/** Reads as the app's own icon set: inline SVG, 16px, `currentColor`. */
function IconEye({ off }: { off: boolean }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.2" />
      {off && <path d="M3 13 13 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
    </svg>
  )
}

/** The address a deployment lives at, as a host name people can recognise. */
function shortHost(server: string): string {
  try {
    return new URL(server).host || server
  } catch {
    return server.replace(/^https?:\/\//, '').replace(/\/+$/, '') || server
  }
}

export function AccountForm({
  server,
  onSignedIn,
  onServerChange,
  dense = false,
  initialMode = 'login'
}: AccountFormProps): JSX.Element {
  const [mode, setMode] = useState<AccountMode>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [address, setAddress] = useState(server)
  const [advanced, setAdvanced] = useState(server.trim() === '')
  const [meta, setMeta] = useState<ServerMeta | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Sign-up only: the mailed code, its confirmation echo and resend cooldown. */
  const [code, setCode] = useState('')
  const [confirm, setConfirm] = useState('')
  const [codeInfo, setCodeInfo] = useState<{ required: boolean } | null>(null)
  const [sending, setSending] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  /** Shown after a password reset; the sign-in view itself never carries it. */
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    setMeta(null)
    setCodeInfo(null)
    setCode('')
    setCooldown(0)
    const base = normalizeServerUrl(address)
    if (!base) return () => { alive = false }
    const timer = setTimeout(() => {
      void window.api.account.meta(base).then((next) => {
        if (!alive) return
        setMeta(next)
        if (next && !next.registrationEnabled) setMode((current) => current === 'register' ? 'login' : current)
        if (next && !next.features.passwordReset) setMode((current) => current === 'reset' ? 'login' : current)
      }).catch(() => {
        // Login reports connection errors. Older servers without discovery
        // continue to be checked by their authentication endpoints.
      })
    }, 350)
    return () => { alive = false; clearTimeout(timer) }
  }, [address])

  const needsCode = meta ? meta.emailVerificationRequired : codeInfo?.required !== false

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const mismatch = mode !== 'login' && confirm.length > 0 && confirm !== password
  const ready =
    email.trim().length > 0 &&
    password.length >= 8 &&
    normalizeServerUrl(address).length > 0 &&
    (mode !== 'register' || meta?.registrationEnabled !== false) &&
    (mode !== 'reset' || meta?.features.passwordReset !== false) &&
    !mismatch &&
    (mode === 'login' ||
      (confirm === password && ((mode === 'register' && !needsCode) || code.trim().length === 6)))

  const sendCode = async (): Promise<void> => {
    if (sending || cooldown > 0 || email.trim().length === 0) return
    setSending(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.account.sendCode({
        serverUrl: address.trim(),
        email: email.trim(),
        purpose: mode === 'reset' ? 'reset' : 'register'
      })
      setCodeInfo(result)
      setCooldown(60)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
          : i18n.t('验证码发送失败')
      )
    } finally {
      setSending(false)
    }
  }
  const hint = password.length === 0 ? '' : password.length < 8 ? i18n.t('密码至少 8 位') : ''

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'reset') {
        await window.api.account.resetPassword({
          serverUrl: address.trim(),
          email: email.trim(),
          code: code.trim(),
          password
        })
        // Every session was revoked server-side, so the honest next step is a
        // sign-in with the new password, not a silent re-login.
        setMode('login')
        setCode('')
        setConfirm('')
        setCodeInfo(null)
        setCooldown(0)
        setPassword('')
        setNotice(i18n.t('密码已重置，请用新密码登录'))
        return
      }
      const next = await window.api.account.signIn({
        serverUrl: address.trim(),
        email: email.trim(),
        password,
        mode,
        ...(mode === 'register' ? { code: code.trim() } : {})
      })
      setPassword('')
      if (next?.serverUrl) onServerChange?.(next.serverUrl)
      onSignedIn(next)
    } catch (err) {
      // Main prefixes every invoke rejection with the channel name; keeping it
      // would show "Error invoking remote method 'account:sign-in':" to a user
      // who just mistyped a password.
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
          : i18n.t(mode === 'reset' ? '重置失败' : '登录失败')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box sx={{ px: dense ? 0 : 2, py: dense ? 0 : 2 }} data-account-form>
      {!dense && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
          <Box
            sx={{
              width: 44,
              height: 44,
              flex: '0 0 auto',
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              background: 'linear-gradient(140deg,#4c8dff,#8f7cff)',
              color: '#fff',
              fontSize: 17,
              fontWeight: 700
            }}
          >
            T
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>
              {i18n.t('登录 轻令（Qinly）')}
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25, lineHeight: 1.45 }}>
              {i18n.t('登录后，历史和随记会在你的几台机器之间自动对齐')}
            </Typography>
          </Box>
        </Box>
      )}

      {mode === 'reset' ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{i18n.t('重置密码')}</Typography>
          <Box sx={{ flex: 1 }} />
          <Box
            component="button"
            type="button"
            data-account-back
            onClick={() => {
              setMode('login')
              setError('')
              setNotice('')
              setCode('')
              setConfirm('')
              setCodeInfo(null)
              setCooldown(0)
            }}
            sx={{
              p: 0,
              border: 0,
              bgcolor: 'transparent',
              color: 'text.disabled',
              fontSize: 11,
              cursor: 'pointer',
              '&:hover': { color: 'text.secondary' }
            }}
          >
            {i18n.t('返回登录')}
          </Box>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Segmented<AccountMode>
            value={mode}
            onChange={(value) => {
              setMode(value)
              setError('')
              setNotice('')
              setCode('')
              setConfirm('')
              setCodeInfo(null)
              setCooldown(0)
            }}
            options={[
              { value: 'login', label: i18n.t('登录') },
              ...(meta?.registrationEnabled === false ? [] : [{ value: 'register' as const, label: i18n.t('注册') }])
            ]}
          />
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: 11, color: 'text.disabled' }} noWrap>
            {shortHost(address)}
          </Typography>
        </Box>
      )}

      <TextField
        fullWidth
        size="small"
        value={email}
        autoComplete="username"
        autoFocus={dense}
        placeholder={i18n.t('邮箱地址')}
        onChange={(event) => {
          setEmail(event.target.value)
          setError('')
        }}
        inputProps={{ 'data-account-email': true, spellCheck: false, 'aria-label': i18n.t('邮箱') }}
        sx={{ mb: 1 }}
      />

      {((mode === 'register' && needsCode) || mode === 'reset') ? (
        <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
          <TextField
            fullWidth
            size="small"
            value={code}
            placeholder={i18n.t('邮箱验证码')}
            onChange={(event) => {
              setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              setError('')
            }}
            inputProps={{
              'data-account-code': true,
              inputMode: 'numeric',
              'aria-label': i18n.t('邮箱验证码')
            }}
          />
          <Button
            variant="outlined"
            data-account-send-code
            disabled={sending || cooldown > 0 || email.trim().length === 0}
            onClick={() => void sendCode()}
            sx={{ flex: '0 0 auto', minWidth: 92, textTransform: 'none', fontSize: 12, whiteSpace: 'nowrap' }}
          >
            {sending ? (
              <CircularProgress size={14} sx={{ color: 'inherit' }} />
            ) : cooldown > 0 ? (
              i18n.t('{{n}} 秒', { n: cooldown })
            ) : (
              i18n.t('发送验证码')
            )}
          </Button>
        </Box>
      ) : null}

      {mode === 'register' && !needsCode ? (
        <Typography data-account-no-code sx={{ mb: 1, fontSize: 11, color: 'text.secondary', lineHeight: 1.5 }}>
          {i18n.t('这台服务器不需要邮箱验证码，直接注册即可')}
        </Typography>
      ) : null}

      <TextField
        fullWidth
        size="small"
        type={reveal ? 'text' : 'password'}
        value={password}
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        placeholder={i18n.t('密码（至少 8 位）')}
        onChange={(event) => {
          setPassword(event.target.value)
          setError('')
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit()
        }}
        inputProps={{ 'data-account-password': true, 'aria-label': i18n.t('密码') }}
        InputProps={{
          endAdornment: (
            <Box
              component="button"
              type="button"
              onClick={() => setReveal((value) => !value)}
              aria-label={reveal ? i18n.t('隐藏密码') : i18n.t('显示密码')}
              sx={{
                display: 'grid',
                placeItems: 'center',
                width: 22,
                height: 22,
                ml: 0.5,
                p: 0,
                border: 0,
                bgcolor: 'transparent',
                color: 'text.disabled',
                cursor: 'pointer',
                '&:hover': { color: 'text.secondary' }
              }}
            >
              <IconEye off={reveal} />
            </Box>
          )
        }}
        helperText={hint || undefined}
        FormHelperTextProps={{ sx: { mx: 0, fontSize: 11 } }}
        sx={{ mb: 1.5 }}
      />

      {mode !== 'login' ? (
        <TextField
          fullWidth
          size="small"
          type={reveal ? 'text' : 'password'}
          value={confirm}
          autoComplete="new-password"
          placeholder={i18n.t('再输一次密码')}
          onChange={(event) => {
            setConfirm(event.target.value)
            setError('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          inputProps={{ 'data-account-confirm': true, 'aria-label': i18n.t('确认密码') }}
          error={mismatch}
          helperText={mismatch ? i18n.t('两次输入的密码不一样') : undefined}
          FormHelperTextProps={{ sx: { mx: 0, fontSize: 11 } }}
          sx={{ mb: 1.5 }}
        />
      ) : null}

      {notice ? (
        <Box
          data-account-notice
          sx={{
            mb: 1.5,
            px: 1.25,
            py: 1,
            borderRadius: '8px',
            bgcolor: 'rgba(76,141,255,.12)',
            border: 1,
            borderColor: 'rgba(76,141,255,.28)'
          }}
        >
          <Typography sx={{ fontSize: 11.5, color: 'primary.main', lineHeight: 1.5 }}>{notice}</Typography>
        </Box>
      ) : null}

      {error ? (
        <Box
          data-account-error
          sx={{
            mb: 1.5,
            px: 1.25,
            py: 1,
            borderRadius: '8px',
            bgcolor: 'rgba(240,106,106,.12)',
            border: 1,
            borderColor: 'rgba(240,106,106,.28)'
          }}
        >
          <Typography sx={{ fontSize: 11.5, color: 'error.main', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
            {error}
          </Typography>
        </Box>
      ) : null}

      <Button
        fullWidth
        variant="contained"
        data-account-login={mode === 'login' ? true : undefined}
        data-account-register={mode === 'register' ? true : undefined}
        data-account-reset={mode === 'reset' ? true : undefined}
        disabled={!ready || busy}
        onClick={() => void submit()}
        sx={{ height: 34, textTransform: 'none', fontSize: 13, boxShadow: 'none' }}
      >
        {busy ? (
          <CircularProgress size={16} sx={{ color: 'inherit' }} />
        ) : mode === 'login' ? (
          i18n.t('登录')
        ) : mode === 'register' ? (
          i18n.t('创建账号')
        ) : (
          i18n.t('重置密码')
        )}
      </Button>

      {mode === 'login' && meta?.features.passwordReset !== false ? (
        <Box sx={{ mt: 1, textAlign: 'center' }}>
          <Box
            component="button"
            type="button"
            data-account-forgot
            onClick={() => {
              setMode('reset')
              setError('')
              setNotice('')
              setCode('')
              setConfirm('')
              setCodeInfo(null)
              setCooldown(0)
            }}
            sx={{
              p: 0,
              border: 0,
              bgcolor: 'transparent',
              color: 'text.disabled',
              fontSize: 11,
              cursor: 'pointer',
              '&:hover': { color: 'text.secondary' }
            }}
          >
            {i18n.t('忘记密码？')}
          </Box>
        </Box>
      ) : null}

      <Box sx={{ mt: 1.25 }}>
        <Box
          component="button"
          type="button"
          onClick={() => setAdvanced((value) => !value)}
          data-account-advanced
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            p: 0,
            border: 0,
            bgcolor: 'transparent',
            color: 'text.disabled',
            fontSize: 11,
            cursor: 'pointer',
            '&:hover': { color: 'text.secondary' }
          }}
        >
          <Box
            component="span"
            aria-hidden
            sx={{
              fontSize: 9,
              lineHeight: 1,
              transition: 'transform 120ms',
              transform: advanced ? 'none' : 'rotate(-90deg)'
            }}
          >
            ▾
          </Box>
          {i18n.t('高级：服务器地址')}
        </Box>
        {advanced && (
          <Box sx={{ mt: 1 }}>
            <TextField
              fullWidth
              size="small"
              value={address}
              placeholder="https://typeless.example.com"
              onChange={(event) => {
                setAddress(event.target.value)
                onServerChange?.(event.target.value)
                setError('')
              }}
              inputProps={{ 'data-account-server': true, spellCheck: false }}
              helperText={i18n.t('填写自行部署的 HTTP 或 HTTPS 服务端地址')}
              FormHelperTextProps={{ sx: { mx: 0, fontSize: 11 } }}
            />
          </Box>
        )}
      </Box>
    </Box>
  )
}
