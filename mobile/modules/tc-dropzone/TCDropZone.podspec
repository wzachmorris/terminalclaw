Pod::Spec.new do |s|
  s.name           = 'TCDropZone'
  s.version        = '0.1.0'
  s.summary        = 'Drag-and-drop target view for TerminalClaw'
  s.description    = 'UIDropInteraction wrapper: drop a screenshot from Finder/Photos onto the chat to upload it.'
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
