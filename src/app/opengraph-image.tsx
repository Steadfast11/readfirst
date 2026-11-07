import { ImageResponse } from 'next/og'

export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export const alt = 'Readfirst: cold email that waits for your OK'

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 96, background: '#ffffff', color: '#16191d' }}>
        <div style={{ fontSize: 40, fontWeight: 600, color: '#151412' }}>Readfirst</div>
        <div style={{ fontSize: 76, fontWeight: 600, marginTop: 24, lineHeight: 1.1 }}>Cold email that waits for your OK.</div>
      </div>
    ),
    size,
  )
}
