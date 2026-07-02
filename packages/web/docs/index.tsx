import './home.css';
import { useState } from 'react';
import {
  IoCheckmark,
  IoCopyOutline,
  IoShieldCheckmarkSharp,
  IoGitMergeSharp,
  IoSpeedometerSharp,
  IoLayersSharp,
  IoCheckmarkDone,
  IoBook,
  IoLogoGithub,
} from 'react-icons/io5';
import { FaNpm } from 'react-icons/fa';
import { MdSpeed } from 'react-icons/md';
import { PiWavesBold } from 'react-icons/pi';
import {
  installCode,
  actionCode,
  serviceCode,
  serverCode,
  invokeCode,
  installRaw,
  actionRaw,
  serviceRaw,
  serverRaw,
  invokeRaw,
} from '../home-code-blocks';

const BASE_PATH = '/delta-agents';
const withBase = (path: string) => `${BASE_PATH}${path}`;

export const frontmatter = {
  pageType: 'custom',
};

const CopyButton = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button className="copy-button" onClick={handleCopy} type="button">
      {copied ? <IoCheckmark /> : <IoCopyOutline />}
    </button>
  );
};

export default function Home() {
  return (
    <div className="dialogue-home">
      {/* Top Spotlight Background */}
      <div
        className="spotlight-bg"
        style={{
          background: `
            radial-gradient(
              circle at top,
              rgba(255, 255, 255, 0.08) 0%,
              rgba(255, 255, 255, 0.08) 20%,
              rgba(0, 0, 0, 0.0) 60%
            )
          `,
        }}
      />
      <section className="hero">
        <div className="hero-content">
          <h1 className="hero-title">
            <span className="hero-icon">
              <PiWavesBold />
            </span>
            <span className="highlight">Delta Agents</span>
          </h1>
          <p className="hero-tagline">
            A deterministic governance and control-plane engine for AI agents.
          </p>
          <p className="hero-description">
            The model reasons and proposes actions. The engine authorizes,
            supervises, budgets, and audits every real action through one
            execution gateway.
            <br /><br />
            Governance does not improve or degrade with the model. A weaker
            model is still safe. A stronger model is still bounded.
          </p>
          <div className="hero-actions">
            <a
              className="btn btn-primary"
              href={withBase('/guide/start/getting-started')}>
              Get Started
            </a>
            <a
              className="btn btn-secondary"
              href="https://github.com/hussein-kizz/delta-agents"
              rel="noopener noreferrer"
              target="_blank">
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      <section className="installation">
        <h2>Installation</h2>
        <div className="code-wrapper">
          <div
            className="code-block"
            dangerouslySetInnerHTML={{ __html: installCode }}
          />
          <CopyButton code={installRaw} />
        </div>
      </section>

      <section className="quick-start">
        <h2>How It Works</h2>
        <div className="code-grid">
          <div className="code-column">
            <h3>1. Define an Action</h3>
            <div className="code-wrapper">
              <div
                className="code-block"
                dangerouslySetInnerHTML={{ __html: actionCode }}
              />
              <CopyButton code={actionRaw} />
            </div>
          </div>
          <div className="code-column">
            <h3>2. Define an Agent</h3>
            <div className="code-wrapper">
              <div
                className="code-block"
                dangerouslySetInnerHTML={{ __html: serviceCode }}
              />
              <CopyButton code={serviceRaw} />
            </div>
          </div>
        </div>
        <div className="code-grid" style={{ marginTop: '1rem' }}>
          <div className="code-column">
            <h3>3. Send a Goal</h3>
            <div className="code-wrapper">
              <div
                className="code-block"
                dangerouslySetInnerHTML={{ __html: serverCode }}
              />
              <CopyButton code={serverRaw} />
            </div>
          </div>
          <div className="code-column">
            <h3>4. Approve and Resume</h3>
            <div className="code-wrapper">
              <div
                className="code-block"
                dangerouslySetInnerHTML={{ __html: invokeCode }}
              />
              <CopyButton code={invokeRaw} />
            </div>
          </div>
        </div>
      </section>

      <section className="features why-care">
        <h2 className="features-title">Why You Should Care</h2>
        <div className="features-grid">
          <div className="feature feature-large">
            <div className="feature-icon">
              <IoShieldCheckmarkSharp />
            </div>
            <h3>One Execution Gateway</h3>
            <p>
              Every action a deployed agent requests, regardless of which
              model or workflow produced it, passes through the same schema
              validation, legality check, approval gate, and audit record.
              There is no second path to a capability.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon">
              <IoLayersSharp />
            </div>
            <h3>Human Oversight</h3>
            <p>
              Mark an action <code>requiresApproval</code> and the engine
              will not run it until a human calls <code>approve</code>. The
              engine also escalates on its own when risk, trust, or budget
              signals cross a threshold.
            </p>
          </div>
          <div className="feature feature-tall">
            <div className="feature-icon">
              <MdSpeed />
            </div>
            <h3>Risk and Trust, Not Fixed Labels</h3>
            <p>
              A declared risk is a starting prior. The engine continuously
              revises risk and trust for a task from observed evidence, so a
              misbehaving action is caught even if it was declared low risk.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon">
              <IoSpeedometerSharp />
            </div>
            <h3>Multi-Axis Budget</h3>
            <p>
              Budgets enforce tokens, duration, memory, latency, and money.
              A workflow's anticipated cost is projected against the budget
              before it runs, not just checked after the fact.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon">
              <IoGitMergeSharp />
            </div>
            <h3>Workflows and Phases</h3>
            <p>
              Compose ordered phases with declared supervision strategies:
              retry, restart, resume from checkpoint, escalate, or abort. A
              failed phase recovers exactly the way you declared it should.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon">
              <IoCheckmarkDone />
            </div>
            <h3>Bounded Delegation</h3>
            <p>
              An agent can delegate a scoped sub-goal to a teammate. Delegated
              budget is clamped to the parent's remaining headroom, and
              concurrency is bounded, so delegation never runs away.
            </p>
          </div>
        </div>
      </section>

      <section className="features ecosystem">
        <h2 className="features-title">Ecosystem</h2>
        <div className="features-grid">
          <a
            className="feature community-link"
            href="https://www.npmjs.com/package/delta-agents"
            rel="noopener noreferrer"
            target="_blank">
            <div className="feature-icon">
              <FaNpm />
            </div>
            <h3>npm</h3>
            <p>Install the package and start defining actions and agents.</p>
          </a>
          <a
            className="feature community-link"
            href={withBase('/guide/start/getting-started')}>
            <div className="feature-icon">
              <IoBook />
            </div>
            <h3>Documentation</h3>
            <p>Read the guide to actions, workflows, and human oversight.</p>
          </a>
          <a
            className="feature feature-large community-link"
            href="https://github.com/hussein-kizz/delta-agents"
            rel="noopener noreferrer"
            target="_blank">
            <div className="feature-icon">
              <IoLogoGithub />
            </div>
            <h3>GitHub</h3>
            <p>View the source, report issues, and read the specification.</p>
          </a>
        </div>
      </section>

      <footer className="home-footer">
        <p>
          Built with love by{' '}
          <a
            href="https://github.com/Hussseinkizz"
            rel="noopener noreferrer"
            target="_blank">
            Hussein Kizz
          </a>
        </p>
      </footer>
    </div>
  );
}
