import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import HalftoneWordmarkFooter from '@/components/ui/halftone-wordmark-footer';
import { MessageCircleIcon, type MessageCircleIconHandle } from '@/components/ui/message-circle';
import './styles.css';

// Provider-generated public join link. Sending this once routes the shared line to Cleo.
const joinLink = 'sms:+17796251378?body=Hi!%20(K-Q9C4YM)';

function App() {
  const icon = useRef<MessageCircleIconHandle>(null);
  return <div className="page">
    <div className="wordmark">
      <HalftoneWordmarkFooter as="header" wordmark="cleo" label="" meta="" columns={[]} backToTop={false}
        className="landing-wordmark" palette={{ background: '#ffffff', ink: '#2458e6', warm: '#1439ad' }}
        height="clamp(145px, 36vw, 240px)" crop={0} dotGap={4} grain={0} />
    </div>
    <main>
      <p className="intro">Your AI contract assistant</p>
      <h1>She redlines.<br />You can ask her why.</h1>
      <div className="description">
        <p>Cleo redlines your contracts. Text her anytime to ask about a change.</p>
        <p>On a call, she’ll share her screen and walk you through the edits. Invite opposing counsel or anyone else, and she’ll explain and defend her changes directly.</p>
      </div>
      <a className="text-button" href={joinLink}
        onMouseEnter={() => icon.current?.startAnimation()} onMouseLeave={() => icon.current?.stopAnimation()}
        onFocus={() => icon.current?.startAnimation()} onBlur={() => icon.current?.stopAnimation()}>
        <MessageCircleIcon ref={icon} size={22} /> <span>Text Cleo</span><span className="arrow" aria-hidden="true">↗</span>
      </a>
      <p className="hint">Opens Messages with a hello ready to send.</p>
      <details className="fallback"><summary>Messages didn’t open?</summary>
        <p>On your phone, text <strong>Hi! (K-Q9C4YM)</strong> to <a href="sms:+17796251378">+1 779 625 1378</a>.<br />Keep the code in your first message so it reaches Cleo.</p>
      </details>
      <p className="install-note">On-screen summoning requires a local <a href="https://github.com/vedantdas312-cell/cleo">GitHub install</a> (no Apple developer licence yet).</p>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
