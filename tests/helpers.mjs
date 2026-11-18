/** Shared helpers for the Playwright end-to-end suites. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Quit the app without leaving a native dialog on screen: unsaved documents are answered
 * with "Don't Save" (picked by its label, wherever the prompt puts it), then the app quits normally.
 * If it still hasn't exited after `timeout` ms it is killed, so a suite can never hang.
 */
export async function closeApp(app, timeout = 10000) {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise((r) => proc.once('exit', r))
  try {
    await app.evaluate(({ dialog }) => {
      const dontSave = (args) => {
        const opts = args.find((a) => a && Array.isArray(a.buttons))
        const i = opts ? opts.buttons.findIndex((b) => /不保存|Don't Save/.test(b)) : -1
        return i >= 0 ? i : 1
      }
      dialog.showMessageBox = async (...args) => ({ response: dontSave(args), checkboxChecked: false })
      dialog.showMessageBoxSync = (...args) => dontSave(args)
    })
  } catch {
    // The app may already be shutting down.
  }
  app.close().catch(() => {})
  const done = await Promise.race([exited.then(() => true), sleep(timeout).then(() => false)])
  if (!done) {
    proc.kill('SIGKILL')
    await exited
  }
}
