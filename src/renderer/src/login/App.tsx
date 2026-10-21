/**
 * Standalone sign-in window.
 *
 * Its own BrowserWindow rather than a panel inside settings: an account is the
 * one thing a new install must be able to sort out before anything else makes
 * sense, and the settings dialog is too heavy a room to ask in. Closing the
 * window is a supported answer — dictation, history and notes all work signed
 * out, so 「稍后再说」 only defers the sync, never the app.
 */
import { useEffect } from 'react'
import { Box, Button, CssBaseline, ThemeProvider, Typography } from '@mui/material'
import { useSettings } from '../settings/useSettings'
import { makeTheme } from '../settings/theme'
import { AccountForm } from '../settings/AccountForm'
import i18n, { applyUiLanguage } from '../i18n'

export function App(): JSX.Element {
  const { settings, patch } = useSettings()

  // This window never reloads, so the language has to be applied imperatively —
  // the same call the hub makes in its own effect.
  const language = settings?.uiLanguage
  useEffect(() => {
    if (language) applyUiLanguage(language)
  }, [language])

  const close = (): void => {
    void window.api.account.closeLogin()
  }

  const themeMode = settings?.themeMode === 'light' ? 'light' : 'dark'

  return (
    <ThemeProvider theme={makeTheme(themeMode)}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          p: 3,
          bgcolor: 'background.default'
        }}
      >
        <Box>
          <Typography sx={{ fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}>
            {i18n.t('登录 / 注册')}
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, lineHeight: 1.55 }}>
            {i18n.t('登录后可以在几台机器之间同步历史')}
          </Typography>
        </Box>

        {settings ? (
          <AccountForm
            server={settings.syncServerUrl}
            onServerChange={(value) => patch({ syncServerUrl: value })}
            onSignedIn={close}
          />
        ) : null}

        <Box sx={{ flex: 1 }} />
        <Button
          data-login-later
          onClick={close}
          sx={{ alignSelf: 'flex-start', textTransform: 'none', fontSize: 12, color: 'text.secondary' }}
        >
          {i18n.t('稍后再说')}
        </Button>
      </Box>
    </ThemeProvider>
  )
}
