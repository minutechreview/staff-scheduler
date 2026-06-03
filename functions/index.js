const { onDocumentCreated } = require('firebase-functions/v2/firestore')
const { initializeApp } = require('firebase-admin/app')
const nodemailer = require('nodemailer')

initializeApp()

// Configure SMTP from environment variables
const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com'
const smtpPort = Number(process.env.SMTP_PORT) || 587
const smtpUser = process.env.SMTP_USER
const smtpPass = process.env.SMTP_PASS
const fromEmail = process.env.FROM_EMAIL || smtpUser || 'noreply@your-company.com'

let transporter = null
if (smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  })
} else {
  console.warn(
    '[WelcomeEmail] SMTP credentials not configured. ' +
    'Set SMTP_USER and SMTP_PASS (and optionally SMTP_HOST, SMTP_PORT, FROM_EMAIL) ' +
    'via: firebase functions:env:set SMTP_USER=... SMTP_PASS=...'
  )
}

exports.sendWelcomeEmail = onDocumentCreated(
  {
    document: 'users/{userId}',
    // Optional: increase memory if sending many emails at once
    memory: '256MiB',
  },
  async (event) => {
    const snapshot = event.data
    if (!snapshot) {
      console.log('[WelcomeEmail] No snapshot data')
      return
    }

    const userData = snapshot.data()
    const email = snapshot.id // document ID is the user's email

    if (!transporter) {
      console.log(`[WelcomeEmail] Skipping welcome email for ${email} — no transporter configured`)
      return
    }

    const role = userData.role || 'SM'
    const roleLabel =
      role === 'ADMIN' ? 'Administrator' :
      role === 'DM' ? 'District Manager' :
      'Store Manager'
    const firstName = userData.displayName?.split(' ')[0] || 'there'

    const mailOptions = {
      from: `"RetailCo Store Scheduler" <${fromEmail}>`,
      to: email,
      subject: 'Welcome to Store Scheduler',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1f1f1f;">
          <div style="background: #006241; padding: 32px 24px; text-align: center; border-radius: 12px 12px 0 0;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 600;">Store Scheduler</h1>
            <p style="color: rgba(255,255,255,0.7); margin: 8px 0 0; font-size: 13px;">RetailCo — Staff Scheduling</p>
          </div>
          <div style="padding: 32px 24px; background: #ffffff; border-radius: 0 0 12px 12px; border: 1px solid #e5e5e5; border-top: none;">
            <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">Hi ${firstName},</p>
            <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">
              Your account has been set up as <strong style="color: #006241;">${roleLabel}</strong>.
              You can now access the scheduling dashboard and manage your weekly rotas.
            </p>
            <div style="text-align: center; margin: 28px 0;">
              <a href="${process.env.APP_URL || 'https://your-app-url.web.app'}" style="display: inline-block; background: #006241; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 600;">Open Store Scheduler</a>
            </div>
            <p style="margin: 0; font-size: 13px; color: #666; line-height: 1.5;">
              If you have any questions, reach out to your District Manager or use the feedback button inside the app.
            </p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
            <p style="margin: 0; font-size: 11px; color: #999;">
              This is an automated message from Store Scheduler.<br />
              RetailCo
            </p>
          </div>
        </div>
      `,
    }

    try {
      await transporter.sendMail(mailOptions)
      console.log(`[WelcomeEmail] Sent welcome email to ${email} (${roleLabel})`)
    } catch (err) {
      console.error(`[WelcomeEmail] Failed to send welcome email to ${email}:`, err)
      // Throwing allows Firebase to retry (background functions retry by default)
      throw err
    }
  }
)
