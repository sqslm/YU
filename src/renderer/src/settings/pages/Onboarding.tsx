/**
 * First-run tour (REQ-15).
 *
 * Four steps, each one a real check rather than a screenshot of one:
 *  1. what the app does, and where the data lives;
 *  2. a live microphone meter driven by `getUserMedia` + `AnalyserNode`, so a
 *     muted or wrong device is caught before the first dictation;
 *  3. a playground textarea: hold Right Alt, speak, and watch the text land;
 *  4. an optional sign-in. It is last on purpose: the account only buys
 *     cross-machine sync, so asking before the user has seen a single sentence
 *     land would read as a wall in front of a local-first app.
 *
 * Completion is remembered in `settings.onboarded` (owned by the hub, not by this
 * component). The tour is a projection of that flag: finishing and skipping both
 * set it, and clearing the browser cache cannot replay it.
 */
import { useEffect, useRef, useState } from 'react'
import { Box, Button, LinearProgress, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AccountView } from '@shared/types'
import { AccountForm } from '../AccountForm'

const STEPS = ['welcome', 'mic', 'playground', 'account'] as const
type Step = (typeof STEPS)[number]

export interface OnboardingProps {
  onDone: () => void
  /** Server address from settings, pre-filled into the sign-in step. */
  server?: string
  onServerChange?: (server: string) => void
}

export function Onboarding({ onDone, server = '', onServerChange }: OnboardingProps): JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('welcome')
  const [level, setLevel] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)
  const [playground, setPlayground] = useState('')
  const [signedIn, setSignedIn] = useState<AccountView | null>(null)
  const meter = useRef<{ stop: () => void } | null>(null)

  // The meter runs only on the microphone step and is torn down on the way out,
  // so the tour never keeps the device open behind the user's back.
  useEffect(() => {
    if (step !== 'mic') return
    let cancelled = false
    void startMeter()
      .then((handle) => {
        if (cancelled) handle.stop()
        else meter.current = handle
      })
      .catch((err: unknown) => {
        if (!cancelled) setMicError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      meter.current?.stop()
      meter.current = null
    }

    async function startMeter(): Promise<{ stop: () => void }> {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128))
        setLevel(Math.min(1, peak / 64))
      }, 80)
      return {
        stop: () => {
          window.clearInterval(timer)
          for (const track of stream.getTracks()) track.stop()
          void context.close()
        }
      }
    }
  }, [step])

  const finish = (): void => {
    onDone()
  }

  const index = STEPS.indexOf(step)
  const heading =
    step === 'welcome'
      ? t('onboarding.welcomeTitle')
      : step === 'mic'
        ? t('onboarding.micTitle')
        : step === 'playground'
          ? t('onboarding.tryItTitle')
          : t('onboarding.accountTitle')

  return (
    <Box
      data-onboarding
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(6px)',
        bgcolor: 'rgba(12,14,18,0.72)'
      }}
    >
      <Box
        sx={{
          width: 520,
          maxWidth: '90vw',
          p: 3,
          borderRadius: 3,
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          boxShadow: 6
        }}
      >
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>
          {t('onboarding.step', { current: index + 1, total: STEPS.length })}
        </Typography>
        <Typography sx={{ fontSize: 19, fontWeight: 600, mb: 1 }}>{heading}</Typography>

        {step === 'welcome' && (
          <Typography sx={{ fontSize: 13, color: 'text.secondary', lineHeight: 1.7 }}>
            {t('onboarding.welcomeBody')}
          </Typography>
        )}

        {step === 'mic' && (
          <Box sx={{ mt: 1 }}>
            <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1.5 }}>
              {t('onboarding.micBody')}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={Math.round(level * 100)}
              sx={{ height: 8, borderRadius: 4 }}
            />
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 1 }}>
              {micError
                ? `${micError} · ${t('onboarding.micWaiting')}`
                : level > 0.05
                  ? t('onboarding.micPassed')
                  : t('onboarding.micWaiting')}
            </Typography>
          </Box>
        )}

        {step === 'playground' && (
          <Box sx={{ mt: 1 }}>
            <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1.5 }}>
              {t('onboarding.tryItBody')}
            </Typography>
            <TextField
              multiline
              minRows={4}
              fullWidth
              value={playground}
              onChange={(event) => setPlayground(event.target.value)}
              placeholder={t('onboarding.playgroundSampleAfter')}
              inputProps={{ 'data-onboarding-playground': true, spellCheck: false }}
              sx={{ '& textarea': { fontSize: 13, lineHeight: 1.7 } }}
            />
            {/* One click turns the sample into what it should look like, so the
                step shows the actual effect instead of describing it. */}
            <Button
              size="small"
              data-onboarding-playground-sample
              onClick={() => setPlayground(t('onboarding.playgroundSampleAfter'))}
              sx={{ mt: 1, minWidth: 0, px: 1, fontSize: 11, color: 'text.secondary' }}
            >
              {t('onboarding.playgroundShowResult')}
            </Button>
          </Box>
        )}

        {step === 'account' && (
          <Box sx={{ mt: 1 }}>
            <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1.75 }}>
              {t('onboarding.accountBody')}
            </Typography>
            {signedIn ? (
              <Box
                data-onboarding-signed-in
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  px: 1.5,
                  py: 1.25,
                  borderRadius: '10px',
                  border: 1,
                  borderColor: 'divider',
                  bgcolor: 'action.hover'
                }}
              >
                <Box
                  sx={{
                    width: 30,
                    height: 30,
                    flex: '0 0 auto',
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    background: 'linear-gradient(140deg,#4c8dff,#8f7cff)',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 700
                  }}
                >
                  {signedIn.email.slice(0, 1).toUpperCase()}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }} noWrap>
                    {t('onboarding.accountSignedIn', { email: signedIn.email })}
                  </Typography>
                  <Typography sx={{ fontSize: 11, color: 'text.secondary' }} noWrap>
                    {signedIn.serverUrl}
                  </Typography>
                </Box>
              </Box>
            ) : (
              <AccountForm
                dense
                server={server}
                onServerChange={onServerChange}
                onSignedIn={(next) => {
                  if (next) setSignedIn(next)
                }}
              />
            )}
          </Box>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2.5 }}>
          <Button size="small" onClick={finish} data-onboarding-skip>
            {step === 'account' && !signedIn ? t('onboarding.later') : t('onboarding.skip')}
          </Button>
          <Box sx={{ flex: 1 }} />
          {index > 0 && (
            <Button
              size="small"
              onClick={() => setStep(STEPS[Math.max(0, index - 1)]!)}
              data-onboarding-back
            >
              {t('onboarding.back')}
            </Button>
          )}
          <Button
            size="small"
            variant="contained"
            data-onboarding-next
            onClick={() => {
              if (index === STEPS.length - 1) finish()
              else setStep(STEPS[index + 1]!)
            }}
          >
            {index === STEPS.length - 1 ? t('onboarding.done') : t('onboarding.next')}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
