Pod::Spec.new do |s|
  s.name           = 'TCSelText'
  s.version        = '0.1.0'
  s.summary        = 'Native selectable text view for TerminalClaw chat bubbles'
  s.description    = 'Read-only UITextView per message: real selection handles on phone, mouse drag + Cmd-C on Mac.'
  s.author         = 'wzachmorris'
  s.homepage       = 'https://github.com/wzachmorris/terminalclaw'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/wzachmorris/terminalclaw.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'ios/**/*.swift'
end
