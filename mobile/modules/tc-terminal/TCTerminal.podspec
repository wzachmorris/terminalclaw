Pod::Spec.new do |s|
  s.name           = 'TCTerminal'
  s.version        = '0.1.0'
  s.summary        = 'Native SwiftTerm-based terminal view for TerminalClaw'
  s.description    = 'Keeps terminal sessions alive natively (no WebKit suspension); vendored SwiftTerm 1.15.0 (MIT).'
  s.author         = 'wzachmorris'
  s.homepage       = 'https://github.com/wzachmorris/terminalclaw'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/wzachmorris/terminalclaw.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'ios/**/*.{h,m,swift,metal}'
end
